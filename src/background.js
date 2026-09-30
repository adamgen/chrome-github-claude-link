/*
 * Service worker: owns the relation store in chrome.storage.local and answers
 * lookups from the GitHub content script. Content scripts never write storage
 * directly, so every mutation goes through the serialized queue below.
 */
importScripts("shared/core.js");

const { emptyDb, upsertSession, addRelation, findSessionsForPr, listRelations, prKey } = self.CGL;

const DB_KEY = "db";
const SYNC_KEY = "sync";
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = {
  autoSync: true,
  syncIntervalMinutes: 15,
  matchBranch: true,
  showMentioned: true,
};

let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function loadDb() {
  const { [DB_KEY]: db } = await chrome.storage.local.get(DB_KEY);
  return db && db.version === 1 ? db : emptyDb();
}

async function loadSync() {
  const { [SYNC_KEY]: sync } = await chrome.storage.local.get(SYNC_KEY);
  return { scanned: {}, lastSyncAt: 0, lastResult: null, ...(sync || {}) };
}

async function loadSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

function record({ sessions = [], relations = [], scanned, syncResult }) {
  return serialized(async () => {
    const db = await loadDb();
    const now = Date.now();
    for (const s of sessions) upsertSession(db, s, now);
    for (const r of relations) addRelation(db, r.sessionId, r.ref, r.ref.kind || r.kind || "mentioned", r.source, now);
    const writes = { [DB_KEY]: db };
    if (scanned || syncResult) {
      const sync = await loadSync();
      if (scanned) sync.scanned = { ...sync.scanned, ...scanned };
      if (syncResult) {
        sync.lastResult = { ...syncResult, at: now };
        if (syncResult.ok) sync.lastSyncAt = now;
      }
      writes[SYNC_KEY] = sync;
    }
    await chrome.storage.local.set(writes);
    return { sessions: Object.keys(db.sessions).length, prs: Object.keys(db.prs).length };
  });
}

async function lookup(prs, tabId) {
  const [db, settings] = await Promise.all([loadDb(), loadSettings()]);
  const results = {};
  const newBranchMatches = [];
  let total = 0;
  for (const pr of prs || []) {
    let found = findSessionsForPr(db, pr, { matchBranch: settings.matchBranch });
    const key = prKey(pr.owner, pr.repo, pr.number);
    for (const f of found) {
      const stored = db.prs[key] && db.prs[key].sessions[f.id];
      if (f.kind === "branch" && (!stored || stored.kind !== "branch")) {
        newBranchMatches.push({ sessionId: f.id, ref: { ...pr, kind: "branch" }, source: "github-branch" });
      }
    }
    if (!settings.showMentioned) found = found.filter((f) => f.kind !== "mentioned");
    results[key] = found;
    total += found.length;
  }
  // Persist branch matches so they show up in the popup and survive the
  // session later being deleted from claude.ai.
  if (newBranchMatches.length) record({ relations: newBranchMatches }).catch(() => {});
  if (tabId != null && prs && prs.length === 1) {
    chrome.action.setBadgeText({ tabId, text: total ? String(total) : "" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#D97757" }).catch(() => {});
  }
  return { results };
}

// ---- sync orchestration -------------------------------------------------

// Tabs we opened ourselves to run a sync; closed again once it finishes.
const ownedSyncTabs = new Set();

async function requestSync({ force = false, openTabIfNeeded = false } = {}) {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "cgl:run-sync", force });
      return { ok: true, via: "tab", tabId: tab.id };
    } catch (_) {
      // Tab without our content script (e.g. opened before install); try next.
    }
  }
  if (!openTabIfNeeded) return { ok: false, reason: "no-claude-tab" };
  const tab = await chrome.tabs.create({ url: "https://claude.ai/code", active: false });
  ownedSyncTabs.add(tab.id);
  return { ok: true, via: "new-tab", tabId: tab.id };
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  chrome.alarms.create("cgl-sync", { periodInMinutes: Math.max(5, settings.syncIntervalMinutes) });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "cgl-sync") return;
  const settings = await loadSettings();
  if (settings.autoSync) requestSync({ force: false }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => ownedSyncTabs.delete(tabId));

// ---- messaging ----------------------------------------------------------

const handlers = {
  async "cgl:record"(msg) {
    return record(msg);
  },
  async "cgl:lookup"(msg, sender) {
    return lookup(msg.prs, sender.tab && sender.tab.id);
  },
  async "cgl:sync-state"(_msg, sender) {
    const [sync, settings] = await Promise.all([loadSync(), loadSettings()]);
    const tabId = sender.tab && sender.tab.id;
    const intervalMs = settings.syncIntervalMinutes * 60 * 1000;
    return {
      scanned: sync.scanned,
      lastSyncAt: sync.lastSyncAt,
      due: ownedSyncTabs.has(tabId) || (settings.autoSync && Date.now() - sync.lastSyncAt > intervalMs),
      force: ownedSyncTabs.has(tabId),
    };
  },
  async "cgl:sync-progress"(msg) {
    chrome.runtime.sendMessage({ type: "cgl:progress", ...msg }).catch(() => {});
    return {};
  },
  async "cgl:sync-done"(msg, sender) {
    await record({ ...msg, syncResult: msg.result });
    chrome.runtime.sendMessage({ type: "cgl:progress", done: true, result: msg.result }).catch(() => {});
    const tabId = sender.tab && sender.tab.id;
    if (ownedSyncTabs.has(tabId)) {
      ownedSyncTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
    return {};
  },
  async "cgl:sync-now"() {
    return requestSync({ force: true, openTabIfNeeded: true });
  },
  async "cgl:overview"() {
    const [db, sync, settings] = await Promise.all([loadDb(), loadSync(), loadSettings()]);
    return {
      relations: listRelations(db),
      sessionCount: Object.keys(db.sessions).length,
      prCount: Object.keys(db.prs).length,
      lastSyncAt: sync.lastSyncAt,
      lastResult: sync.lastResult,
      settings,
    };
  },
  async "cgl:settings"(msg) {
    const settings = { ...(await loadSettings()), ...(msg.settings || {}) };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    chrome.alarms.create("cgl-sync", { periodInMinutes: Math.max(5, settings.syncIntervalMinutes) });
    return { settings };
  },
  async "cgl:export"() {
    return { db: await loadDb() };
  },
  async "cgl:clear"() {
    return serialized(async () => {
      await chrome.storage.local.remove([DB_KEY, SYNC_KEY]);
      return {};
    });
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
