/*
 * Pure helpers shared by the background worker, content scripts, popup and
 * unit tests. No chrome.* APIs in here.
 *
 * Loaded as a classic script (content scripts / importScripts) where it sets
 * `globalThis.CGL`, and as a CommonJS module under Node for tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CGL = Object.assign(root.CGL || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CLAUDE_ORIGIN = "https://claude.ai";

  // Relation kinds, strongest first. The lower the rank, the more confident we
  // are that the session is *the* session behind the PR.
  const KIND_RANK = {
    branch: 0, // session pushed to the PR's head branch
    created: 1, // session output contains the PR creation
    backlink: 2, // PR body / commits link back to the session
    mentioned: 3, // PR URL appears somewhere in the session
  };

  const PR_URL_RE =
    /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?![\d])/g;
  const SESSION_URL_RE =
    /https?:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]{8,64})\b/g;

  function prKey(owner, repo, number) {
    return `${String(owner).toLowerCase()}/${String(repo).toLowerCase()}#${Number(number)}`;
  }

  function parsePrKey(key) {
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key || "");
    return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
  }

  function prUrl(owner, repo, number) {
    return `https://github.com/${owner}/${repo}/pull/${number}`;
  }

  /** Parse a single GitHub PR URL or path (`/o/r/pull/1`, optional subpath). */
  function parsePrUrl(href, { allowSubpath = true } = {}) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, "https://github.com");
    } catch (_) {
      return null;
    }
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(\/.*)?$/.exec(url.pathname);
    if (!m) return null;
    if (!allowSubpath && m[4] && m[4] !== "/") return null;
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }

  /** Every distinct PR referenced by a URL inside `text`. */
  function extractPrRefs(text) {
    const out = new Map();
    if (!text) return [];
    for (const m of String(text).matchAll(PR_URL_RE)) {
      const repo = m[2].replace(/\.git$/, "");
      const key = prKey(m[1], repo, m[3]);
      if (!out.has(key)) out.set(key, { owner: m[1], repo, number: Number(m[3]), key });
    }
    return [...out.values()];
  }

  /** Every distinct Claude Code session id linked (as a claude.ai/code URL) in `text`. */
  function extractSessionLinks(text) {
    const out = new Set();
    if (!text) return [];
    for (const m of String(text).matchAll(SESSION_URL_RE)) out.add(m[1]);
    return [...out];
  }

  function sessionIdFromUrl(href) {
    try {
      const url = new URL(href, CLAUDE_ORIGIN);
      if (!/(^|\.)claude\.ai$/i.test(url.hostname)) return null;
      const m = /^\/code\/(session_[A-Za-z0-9]{8,64})(?:\/|$)/.exec(url.pathname);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  function sessionUrl(sessionId) {
    return `${CLAUDE_ORIGIN}/code/${sessionId}`;
  }

  /** `https://github.com/o/r(.git)` or `o/r` → `o/r` (lowercased), else null. */
  function normalizeRepo(value) {
    if (!value) return null;
    const s = String(value).trim();
    const m =
      /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(s) ||
      /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(s);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  }

  /**
   * Reduce a raw `/v1/sessions` item to what we store: title, repo and the
   * branches the session pushes to (its "outcomes").
   */
  function summarizeApiSession(raw) {
    if (!raw || !raw.id) return null;
    const ctx = raw.session_context || {};
    const repos = new Set();
    const branches = new Set();
    for (const src of ctx.sources || []) {
      if (src && src.type === "git_repository") {
        const r = normalizeRepo(src.url);
        if (r) repos.add(r);
      }
    }
    for (const out of ctx.outcomes || []) {
      const info = out && out.git_info;
      if (!info) continue;
      const r = normalizeRepo(info.repo);
      if (r) repos.add(r);
      for (const b of info.branches || []) if (b) branches.add(String(b));
    }
    return {
      id: raw.id,
      title: raw.title || null,
      status: raw.session_status || raw.status || null,
      repos: [...repos],
      branches: [...branches],
      createdAt: raw.created_at || null,
      updatedAt: raw.updated_at || null,
    };
  }

  /**
   * Decide how a PR relates to a session from one event's JSON: a URL that
   * appears next to a PR-creation tool call is "created", anything else is
   * "mentioned".
   */
  function classifyEventPrRefs(eventJson) {
    const refs = extractPrRefs(eventJson);
    if (!refs.length) return [];
    const created = /create_pull_request|gh pr create|pull request created|created (?:a )?(?:draft )?(?:pull request|PR)\b/i.test(
      eventJson,
    );
    return refs.map((r) => ({ ...r, kind: created ? "created" : "mentioned" }));
  }

  function strongerKind(a, b) {
    if (!a) return b;
    if (!b) return a;
    return (KIND_RANK[a] ?? 99) <= (KIND_RANK[b] ?? 99) ? a : b;
  }

  function emptyDb() {
    return { version: 1, sessions: {}, prs: {} };
  }

  /** Merge session metadata into the db (mutates and returns `db`). */
  function upsertSession(db, session, now = Date.now()) {
    if (!session || !session.id) return db;
    const prev = db.sessions[session.id] || { id: session.id, firstSeen: now };
    const merged = { ...prev };
    for (const [k, v] of Object.entries(session)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) merged[k] = [...new Set([...(prev[k] || []), ...v])];
      else merged[k] = v;
    }
    merged.lastSeen = now;
    db.sessions[session.id] = merged;
    return db;
  }

  /** Record that `sessionId` relates to PR `ref` (mutates and returns `db`). */
  function addRelation(db, sessionId, ref, kind, source, now = Date.now()) {
    if (!sessionId || !ref) return db;
    const key = ref.key || prKey(ref.owner, ref.repo, ref.number);
    const pr = db.prs[key] || {
      owner: ref.owner,
      repo: ref.repo,
      number: Number(ref.number),
      sessions: {},
    };
    const prev = pr.sessions[sessionId];
    pr.sessions[sessionId] = {
      kind: strongerKind(prev && prev.kind, kind),
      sources: [...new Set([...((prev && prev.sources) || []), source].filter(Boolean))],
      firstSeen: (prev && prev.firstSeen) || now,
      lastSeen: now,
    };
    db.prs[key] = pr;
    if (!db.sessions[sessionId]) db.sessions[sessionId] = { id: sessionId, firstSeen: now, lastSeen: now };
    return db;
  }

  /**
   * Sessions related to a PR, strongest first. When `headBranch` is known,
   * sessions that pushed to that branch of the same repo also match.
   */
  function findSessionsForPr(db, { owner, repo, number, headBranch } = {}, { matchBranch = true } = {}) {
    const key = prKey(owner, repo, number);
    const repoKey = `${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`;
    const found = new Map();
    const pr = db.prs[key];
    if (pr) {
      for (const [id, rel] of Object.entries(pr.sessions)) {
        found.set(id, { id, kind: rel.kind, sources: rel.sources || [] });
      }
    }
    if (matchBranch && headBranch) {
      for (const s of Object.values(db.sessions)) {
        if (!(s.branches || []).includes(headBranch)) continue;
        if (!(s.repos || []).some((r) => r === repoKey)) continue;
        const prev = found.get(s.id);
        found.set(s.id, {
          id: s.id,
          kind: strongerKind(prev && prev.kind, "branch"),
          sources: [...new Set([...((prev && prev.sources) || []), "branch"])],
        });
      }
    }
    return [...found.values()]
      .map((r) => {
        const s = db.sessions[r.id] || {};
        return { ...r, title: s.title || null, url: sessionUrl(r.id), updatedAt: s.updatedAt || null };
      })
      .sort(
        (a, b) =>
          (KIND_RANK[a.kind] ?? 99) - (KIND_RANK[b.kind] ?? 99) ||
          String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
      );
  }

  /** Flat, newest-first list of every PR ↔ session relation (for the popup). */
  function listRelations(db) {
    const rows = [];
    for (const [key, pr] of Object.entries(db.prs)) {
      for (const [id, rel] of Object.entries(pr.sessions)) {
        const s = db.sessions[id] || {};
        rows.push({
          prKey: key,
          prUrl: prUrl(pr.owner, pr.repo, pr.number),
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          sessionId: id,
          sessionUrl: sessionUrl(id),
          sessionTitle: s.title || null,
          kind: rel.kind,
          sources: rel.sources || [],
          lastSeen: rel.lastSeen || 0,
        });
      }
    }
    return rows.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  return {
    CLAUDE_ORIGIN,
    KIND_RANK,
    prKey,
    parsePrKey,
    prUrl,
    parsePrUrl,
    extractPrRefs,
    extractSessionLinks,
    sessionIdFromUrl,
    sessionUrl,
    normalizeRepo,
    summarizeApiSession,
    classifyEventPrRefs,
    strongerKind,
    emptyDb,
    upsertSession,
    addRelation,
    findSessionsForPr,
    listRelations,
  };
});
