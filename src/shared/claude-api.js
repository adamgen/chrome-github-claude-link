/*
 * Client for the Claude Code sessions API as used by claude.ai/code
 * (`/v1/sessions`, `/v1/sessions/{id}/events`). It runs inside the claude.ai
 * content script, so requests are same-origin and authenticated by the
 * user's existing claude.ai cookies. Nothing leaves the browser except those
 * requests to claude.ai itself.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CGL = Object.assign(root.CGL || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const BETA_HEADER = "ccr-byoc-2025-07-29";
  const MAX_SESSION_PAGES = 20;
  const MAX_EVENT_PAGES = 50;

  function core() {
    return typeof module === "object" && module.exports ? require("./core.js") : globalThis.CGL;
  }

  function readCookie(cookieString, name) {
    for (const part of String(cookieString || "").split(/;\s*/)) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
    }
    return null;
  }

  /** Message content blocks of an event (tool_use / tool_result / text …). */
  function contentBlocks(ev) {
    const content = ev && ev.message && ev.message.content;
    return Array.isArray(content) ? content.filter((b) => b && typeof b === "object") : [];
  }

  function isCreatePrCall(block) {
    if (/create_pull_request/i.test(block.name || "")) return true;
    let input = "";
    try {
      input = JSON.stringify(block.input || "");
    } catch (_) {
      // ignore
    }
    return /\bgh\s+pr\s+create\b/.test(input);
  }

  class ClaudeSessionsClient {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl  e.g. "https://claude.ai"
     * @param {Function} [opts.fetch]
     * @param {string} [opts.cookieString]  document.cookie, used to find the active org
     */
    constructor({ baseUrl, fetch: fetchImpl, cookieString } = {}) {
      this.baseUrl = (baseUrl || "https://claude.ai").replace(/\/+$/, "");
      this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
      this.cookieString = cookieString || "";
      this.orgUuid = null;
    }

    async _get(path, { org = true } = {}) {
      const headers = {
        accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": BETA_HEADER,
      };
      if (org && this.orgUuid) headers["x-organization-uuid"] = this.orgUuid;
      const res = await this.fetch(this.baseUrl + path, { headers, credentials: "include" });
      if (!res.ok) {
        const err = new Error(`GET ${path} → ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }

    async resolveOrg() {
      if (this.orgUuid) return this.orgUuid;
      this.orgUuid = readCookie(this.cookieString, "lastActiveOrg");
      if (!this.orgUuid) {
        const orgs = await this._get("/api/organizations", { org: false });
        const list = Array.isArray(orgs) ? orgs : orgs && orgs.data;
        if (list && list.length) this.orgUuid = list[0].uuid || list[0].id;
      }
      if (!this.orgUuid) throw new Error("Could not determine the active claude.ai organization");
      return this.orgUuid;
    }

    /** All sessions, newest first as returned by the API. */
    async listSessions({ maxPages = MAX_SESSION_PAGES } = {}) {
      await this.resolveOrg();
      const out = [];
      let after = null;
      for (let page = 0; page < maxPages; page++) {
        const qs = new URLSearchParams({ limit: "100" });
        if (after) qs.set("after_id", after);
        const body = await this._get(`/v1/sessions?${qs}`);
        const data = (body && body.data) || [];
        out.push(...data);
        after = body && (body.last_id || (data.length && data[data.length - 1].id));
        if (!body || !body.has_more || !after) break;
      }
      return out;
    }

    /** Yields every event of a session, page by page. */
    async *iterEvents(sessionId, { maxPages = MAX_EVENT_PAGES } = {}) {
      await this.resolveOrg();
      let after = null;
      for (let page = 0; page < maxPages; page++) {
        const qs = new URLSearchParams();
        if (after) qs.set("after_id", after);
        const q = qs.toString();
        const body = await this._get(`/v1/sessions/${encodeURIComponent(sessionId)}/events${q ? `?${q}` : ""}`);
        const data = (body && body.data) || [];
        for (const ev of data) yield ev;
        after = body && body.last_id;
        if (!body || !body.has_more || !after) break;
      }
    }

    /** PR refs found in a session's events, each tagged created/mentioned. */
    async scanSessionForPrs(sessionId) {
      const { classifyEventPrRefs, extractPrRefs, strongerKind } = core();
      const found = new Map();
      // Tool results only carry the id of their tool call, so remember which
      // calls create PRs (GitHub MCP create_pull_request, `gh pr create`).
      const createCalls = new Set();
      for await (const ev of this.iterEvents(sessionId)) {
        let json;
        try {
          json = JSON.stringify(ev);
        } catch (_) {
          continue;
        }
        const refs = classifyEventPrRefs(json);
        for (const block of contentBlocks(ev)) {
          if (block.type === "tool_use" && block.id && isCreatePrCall(block)) createCalls.add(block.id);
          if (block.type === "tool_result" && createCalls.has(block.tool_use_id)) {
            for (const r of extractPrRefs(JSON.stringify(block))) refs.push({ ...r, kind: "created" });
          }
        }
        for (const ref of refs) {
          const prev = found.get(ref.key);
          found.set(ref.key, prev ? { ...ref, kind: strongerKind(prev.kind, ref.kind) } : ref);
        }
      }
      return [...found.values()];
    }
  }

  /**
   * Run a full (incremental) sync.
   *
   * @param {ClaudeSessionsClient} client
   * @param {object} state  { scanned: { [sessionId]: updatedAt } } from a previous run
   * @param {object} [opts]
   * @param {number} [opts.concurrency]
   * @param {(p: {done:number,total:number}) => void} [opts.onProgress]
   * @returns {Promise<{sessions: object[], relations: {sessionId:string, ref:object}[], scanned: object, errors: string[]}>}
   */
  async function syncSessions(client, state = {}, { concurrency = 3, onProgress } = {}) {
    const { summarizeApiSession, extractPrRefs } = core();
    const raw = await client.listSessions();
    const sessions = raw.map(summarizeApiSession).filter(Boolean);
    const scanned = { ...(state.scanned || {}) };
    const relations = [];
    const errors = [];

    // PR URLs may already be present on the session object itself.
    for (const r of raw) {
      for (const ref of extractPrRefs(JSON.stringify(r))) relations.push({ sessionId: r.id, ref: { ...ref, kind: "mentioned" } });
    }

    const todo = sessions.filter((s) => !s.updatedAt || scanned[s.id] !== s.updatedAt);
    let done = 0;
    let next = 0;
    async function worker() {
      while (next < todo.length) {
        const s = todo[next++];
        try {
          for (const ref of await client.scanSessionForPrs(s.id)) relations.push({ sessionId: s.id, ref });
          if (s.updatedAt) scanned[s.id] = s.updatedAt;
        } catch (e) {
          errors.push(`${s.id}: ${e.message}`);
        }
        done++;
        if (onProgress) onProgress({ done, total: todo.length });
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return { sessions, relations, scanned, errors };
  }

  return { ClaudeSessionsClient, syncSessions, readCookie };
});
