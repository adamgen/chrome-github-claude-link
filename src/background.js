/*
 * Service worker: owns the relation store in chrome.storage.local, polls the
 * native host for changes to local Claude Code sessions, and answers lookups
 * from the GitHub content script. Every storage mutation goes through the
 * serialized queue below.
 */
importScripts("shared/core.js");

const { emptyDb, upsertSession, addRelation, findSessionsForPr, listRelations, prKey, DB_VERSION } = self.CGL;

const HOST_NAME = "com.claude_link.host";
const DB_KEY = "db";
const SCAN_KEY = "scan";
const SETTINGS_KEY = "settings";
const ALARM = "cgl-poll";
const SETTINGS_VERSION = 3;
const DEFAULT_SETTINGS = { pollSeconds: 30 };
// Write to storage in chunks so a first scan of many sessions does not hold
// everything in memory or trigger one huge storage event.
const BATCH = 200;

let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Relations stored under older matching rules are dropped, together with the
// scan state, so every transcript is re-read with the current rules.
const migrated = (async () => {
  const { [DB_KEY]: db, [SETTINGS_KEY]: settings } = await chrome.storage.local.get([DB_KEY, SETTINGS_KEY]);
  if (db && db.version !== DB_VERSION) await chrome.storage.local.remove([DB_KEY, SCAN_KEY]);
  if (settings && settings.version !== SETTINGS_VERSION) {
    // Branch and mention matching are gone; drop their switches.
    const { showMentioned: _mentioned, matchBranch: _branch, ...rest } = settings;
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...rest, version: SETTINGS_VERSION } });
  }
})().catch(() => {});

async function loadDb() {
  await migrated;
  const { [DB_KEY]: db } = await chrome.storage.local.get(DB_KEY);
  return db && db.version === DB_VERSION ? db : emptyDb();
}

async function loadScan() {
  await migrated;
  const { [SCAN_KEY]: scan } = await chrome.storage.local.get(SCAN_KEY);
  return { known: {}, lastScanAt: 0, lastResult: null, ...(scan || {}) };
}

async function loadSettings() {
  await migrated;
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

function record({ sessions = [], relations = [], known, scanResult }) {
  return serialized(async () => {
    const now = Date.now();
    const writes = {};
    if (sessions.length || relations.length) {
      const db = await loadDb();
      for (const s of sessions) upsertSession(db, s, now);
      for (const r of relations) addRelation(db, r.sessionId, r.ref, r.ref.kind || "linked", r.source, now);
      writes[DB_KEY] = db;
    }
    if (known || scanResult) {
      const scan = await loadScan();
      if (known) scan.known = { ...scan.known, ...known };
      if (scanResult) {
        scan.lastResult = { ...scanResult, at: now };
        if (scanResult.ok) scan.lastScanAt = now;
      }
      writes[SCAN_KEY] = scan;
    }
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  });
}

// ---- polling the native host -------------------------------------------

let polling = null;

function poll() {
  if (polling) return polling;
  polling = (async () => {
    ensureAlarm().catch(() => {});
    const { known } = await loadScan();
    const started = Date.now();
    let pending = { sessions: [], relations: [], known: {} };
    let flushes = Promise.resolve();
    const flush = () => {
      const batch = pending;
      pending = { sessions: [], relations: [], known: {} };
      flushes = flushes.then(() => record(batch));
      return flushes;
    };

    const result = await new Promise((resolve) => {
      let port;
      try {
        port = chrome.runtime.connectNative(HOST_NAME);
      } catch (e) {
        resolve({ ok: false, error: e.message, hostMissing: true });
        return;
      }
      let finished = false;
      const finish = (res) => {
        if (finished) return;
        finished = true;
        try {
          port.disconnect();
        } catch (_) {
          // already closed
        }
        resolve(res);
      };
      port.onMessage.addListener((msg) => {
        if (msg.type === "session") {
          if (msg.session) {
            pending.sessions.push(msg.session);
            for (const ref of msg.prs || []) pending.relations.push({ sessionId: msg.session.id, ref, source: "local" });
          }
          pending.known[msg.file] = msg.stat;
          if (pending.sessions.length >= BATCH) flush();
        } else if (msg.type === "done") {
          finish({ ok: true, files: msg.files, changed: msg.changed, projectsDir: msg.projectsDir, ms: Date.now() - started });
        } else if (msg.type === "error") {
          finish({ ok: false, error: msg.error });
        }
      });
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
        finish({
          ok: false,
          error: err || "native host exited unexpectedly",
          hostMissing: /not found|forbidden/i.test(err || ""),
        });
      });
      port.postMessage({ type: "scan", known });
    });

    // Keep whatever arrived even if the scan failed half-way.
    await flush();
    await record({ scanResult: result });
    chrome.runtime.sendMessage({ type: "cgl:scanned", result }).catch(() => {});
    return result;
  })().finally(() => {
    polling = null;
  });
  return polling;
}

async function schedulePolling() {
  const { pollSeconds } = await loadSettings();
  // Chrome 120+ allows alarms as often as every 30 seconds.
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(0.5, pollSeconds / 60), delayInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  schedulePolling();
  poll();
});
chrome.runtime.onStartup.addListener(() => {
  schedulePolling();
  poll();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) poll();
});

// Chrome can drop alarms (e.g. extension disabled and re-enabled, some
// browser restarts), so recreate it whenever the worker wakes up and on every check.
async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await schedulePolling();
}
ensureAlarm();

/** Poll unless a check (successful or not) ran within the polling interval. */
async function pollIfStale() {
  const [{ lastResult }, { pollSeconds }] = await Promise.all([loadScan(), loadSettings()]);
  const lastAttempt = (lastResult && lastResult.at) || 0;
  if (Date.now() - lastAttempt > pollSeconds * 1000) poll();
}

// ---- lookups ------------------------------------------------------------

async function lookup(prs, tabId) {
  const db = await loadDb();
  const results = {};
  let total = 0;
  for (const pr of prs || []) {
    const found = findSessionsForPr(db, pr);
    results[prKey(pr.owner, pr.repo, pr.number)] = found;
    total += found.length;
  }
  if (tabId != null && prs && prs.length === 1) {
    chrome.action.setBadgeText({ tabId, text: total ? String(total) : "" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#D97757" }).catch(() => {});
  }
  return { results };
}

// ---- messaging ----------------------------------------------------------

const handlers = {
  async "cgl:record"(msg) {
    await record({ sessions: msg.sessions, relations: msg.relations });
    return {};
  },
  async "cgl:lookup"(msg, sender) {
    // A GitHub page is open: make sure its data is fresh even if the alarm was lost.
    pollIfStale().catch(() => {});
    return lookup(msg.prs, sender.tab && sender.tab.id);
  },
  async "cgl:poll"() {
    return { result: await poll() };
  },
  async "cgl:overview"() {
    const [db, scan, settings] = await Promise.all([loadDb(), loadScan(), loadSettings()]);
    return {
      relations: listRelations(db),
      sessionCount: Object.keys(db.sessions).length,
      prCount: Object.keys(db.prs).length,
      lastScanAt: scan.lastScanAt,
      lastResult: scan.lastResult,
      polling: !!polling,
      settings,
    };
  },
  async "cgl:settings"(msg) {
    const settings = { ...(await loadSettings()), ...(msg.settings || {}), version: SETTINGS_VERSION };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    await schedulePolling();
    return { settings };
  },
  async "cgl:export"() {
    return { db: await loadDb() };
  },
  async "cgl:clear"() {
    await serialized(() => chrome.storage.local.remove([DB_KEY, SCAN_KEY]));
    poll();
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (res) => sendResponse({ ok: true, ...res }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
  );
  return true;
});
