/*
 * Runs on claude.ai. Two jobs:
 *  1. Sync: read the user's Claude Code sessions through the same API the
 *     claude.ai/code web app uses and report session ↔ PR relations.
 *  2. Passive capture: while a session page is open, pick up any GitHub PR
 *     links rendered in the conversation (works even if the API changes).
 */
(() => {
  "use strict";
  const { ClaudeSessionsClient, syncSessions, extractPrRefs, sessionIdFromUrl } = globalThis.CGL;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res || { ok: false });
        });
      } catch (_) {
        // Extension reloaded while the page stayed open.
        resolve({ ok: false });
      }
    });
  }

  // ---- 1. API sync --------------------------------------------------------

  let syncing = null;

  async function runSync({ force = false } = {}) {
    if (syncing) return syncing;
    syncing = (async () => {
      const state = await send({ type: "cgl:sync-state" });
      if (!force && !(state && state.due)) return;
      const client = new ClaudeSessionsClient({ baseUrl: location.origin, cookieString: document.cookie });
      const started = Date.now();
      try {
        // Incremental even when forced: sessions whose updated_at is unchanged
        // since their last scan cannot have gained new PR links.
        const res = await syncSessions(client, { scanned: (state && state.scanned) || {} }, {
          onProgress: (p) => send({ type: "cgl:sync-progress", ...p }),
        });
        await send({
          type: "cgl:sync-done",
          sessions: res.sessions,
          relations: res.relations.map((r) => ({ ...r, source: "claude-api" })),
          scanned: res.scanned,
          result: {
            ok: true,
            sessions: res.sessions.length,
            relations: res.relations.length,
            errors: res.errors.slice(0, 5),
            ms: Date.now() - started,
          },
        });
      } catch (e) {
        await send({ type: "cgl:sync-done", result: { ok: false, error: e.message, status: e.status || null } });
      }
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "cgl:run-sync") {
      runSync({ force: !!msg.force });
      sendResponse({ ok: true });
    }
    return false;
  });

  // ---- 2. passive DOM capture --------------------------------------------

  const reported = new Set();

  function currentTitle() {
    const t = (document.title || "").replace(/\s*[-|–]\s*Claude(?: Code)?\s*$/i, "").trim();
    return t && !/^claude(?: code)?$/i.test(t) ? t : null;
  }

  function scanPage() {
    const sessionId = sessionIdFromUrl(location.href);
    if (!sessionId) return;
    const hrefs = [...document.querySelectorAll('a[href*="github.com/"][href*="/pull/"]')].map((a) => a.href);
    const text = (document.querySelector("main") || document.body).innerText || "";
    const refs = extractPrRefs(hrefs.join("\n") + "\n" + text);
    const fresh = refs.filter((r) => !reported.has(`${sessionId}|${r.key}`));
    const title = currentTitle();
    const titleKey = `${sessionId}|title|${title}`;
    if (!fresh.length && (!title || reported.has(titleKey))) return;
    fresh.forEach((r) => reported.add(`${sessionId}|${r.key}`));
    if (title) reported.add(titleKey);
    send({
      type: "cgl:record",
      sessions: [{ id: sessionId, title }],
      relations: fresh.map((ref) => ({ sessionId, ref: { ...ref, kind: "mentioned" }, source: "claude-page" })),
    });
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, 1500);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  scheduleScan();

  // ---- kick off -----------------------------------------------------------

  // Give the app a moment to settle (and set its cookies) before syncing.
  setTimeout(() => runSync(), 3000);
})();
