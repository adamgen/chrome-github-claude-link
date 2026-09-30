const test = require("node:test");
const assert = require("node:assert/strict");
const { ClaudeSessionsClient, syncSessions, readCookie } = require("../src/shared/claude-api.js");

function fakeFetch(routes, log) {
  return async (url, init) => {
    const u = new URL(url);
    const key = u.pathname + (u.search || "");
    log.push({ key, headers: init.headers });
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  };
}

const SESSION = (id, updated, branch) => ({
  id,
  title: `T ${id}`,
  updated_at: updated,
  session_context: {
    sources: [{ type: "git_repository", url: "https://github.com/acme/web" }],
    outcomes: [{ type: "git_repository", git_info: { repo: "acme/web", branches: [branch] } }],
  },
});

test("readCookie", () => {
  assert.equal(readCookie("a=1; lastActiveOrg=org-123; b=2", "lastActiveOrg"), "org-123");
  assert.equal(readCookie("a=1", "lastActiveOrg"), null);
});

test("syncSessions paginates, scans events and is incremental", async () => {
  const log = [];
  const routes = {
    "/v1/sessions?limit=100": { data: [SESSION("session_a000000001", "t1", "claude/a")], has_more: true, last_id: "session_a000000001" },
    "/v1/sessions?limit=100&after_id=session_a000000001": { data: [SESSION("session_b000000002", "t2", "claude/b")], has_more: false },
    "/v1/sessions/session_a000000001/events": {
      data: [{ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__github__create_pull_request" }] } }],
      has_more: true,
      last_id: "ev1",
    },
    "/v1/sessions/session_a000000001/events?after_id=ev1": {
      data: [
        { type: "user", tool_use_result: "create_pull_request → https://github.com/acme/web/pull/11" },
        { type: "assistant", text: "Also see https://github.com/acme/web/pull/3" },
      ],
      has_more: false,
    },
    "/v1/sessions/session_b000000002/events": { data: [], has_more: false },
  };
  const client = new ClaudeSessionsClient({ baseUrl: "https://claude.ai", fetch: fakeFetch(routes, log), cookieString: "lastActiveOrg=org-1" });
  const res = await syncSessions(client, {});
  assert.equal(res.errors.length, 0);
  assert.deepEqual(res.sessions.map((s) => s.branches[0]), ["claude/a", "claude/b"]);
  const rels = res.relations.map((r) => `${r.sessionId}:${r.ref.key}:${r.ref.kind}`).sort();
  assert.deepEqual(rels, ["session_a000000001:acme/web#11:created", "session_a000000001:acme/web#3:mentioned"]);
  assert.deepEqual(res.scanned, { session_a000000001: "t1", session_b000000002: "t2" });
  assert.equal(log[0].headers["x-organization-uuid"], "org-1");
  assert.equal(log[0].headers["anthropic-beta"], "ccr-byoc-2025-07-29");

  // Second run with the saved state only lists sessions, no event fetches.
  log.length = 0;
  await syncSessions(client, { scanned: res.scanned });
  assert.ok(log.every((l) => !l.key.includes("/events")), "no event requests for unchanged sessions");
});

test("tool results of PR-creating tool calls count as created", async () => {
  const routes = {
    "/v1/sessions/session_c000000003/events": {
      data: [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "gh pr create --fill" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "https://github.com/acme/web/pull/77\n" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "gh pr view 5" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "https://github.com/acme/web/pull/5" }] } },
      ],
    },
  };
  const client = new ClaudeSessionsClient({ fetch: fakeFetch(routes, []), cookieString: "lastActiveOrg=o" });
  const refs = await client.scanSessionForPrs("session_c000000003");
  assert.deepEqual(refs.map((r) => `${r.key}:${r.kind}`).sort(), ["acme/web#5:mentioned", "acme/web#77:created"]);
});

test("resolveOrg falls back to /api/organizations", async () => {
  const log = [];
  const client = new ClaudeSessionsClient({
    fetch: fakeFetch({ "/api/organizations": [{ uuid: "org-xyz" }] }, log),
    cookieString: "",
  });
  assert.equal(await client.resolveOrg(), "org-xyz");
});

test("sync surfaces auth errors", async () => {
  const client = new ClaudeSessionsClient({ fetch: fakeFetch({}, []), cookieString: "lastActiveOrg=o" });
  await assert.rejects(syncSessions(client, {}), /404/);
});
