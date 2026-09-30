const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/shared/core.js");

test("parsePrUrl handles URLs, paths and subpaths", () => {
  assert.deepEqual(C.parsePrUrl("https://github.com/o/r/pull/12"), { owner: "o", repo: "r", number: 12 });
  assert.deepEqual(C.parsePrUrl("/o/r/pull/12/files"), { owner: "o", repo: "r", number: 12 });
  assert.equal(C.parsePrUrl("/o/r/pull/12/files", { allowSubpath: false }), null);
  assert.deepEqual(C.parsePrUrl("/o/r/pull/12#issuecomment-1", { allowSubpath: false }), { owner: "o", repo: "r", number: 12 });
  assert.equal(C.parsePrUrl("https://gitlab.com/o/r/pull/1"), null);
  assert.equal(C.parsePrUrl("/o/r/issues/1"), null);
});

test("extractPrRefs dedupes and ignores non-PR links", () => {
  const text = `Opened https://github.com/Acme/Web/pull/42 and see
    https://github.com/acme/web/pull/42/files, also https://github.com/acme/web/issues/3
    and "html_url":"https://github.com/x/y.z/pull/7"`;
  const refs = C.extractPrRefs(text);
  assert.deepEqual(refs.map((r) => r.key), ["acme/web#42", "x/y.z#7"]);
});

test("extractSessionLinks and sessionIdFromUrl", () => {
  const body = "Claude-Session: https://claude.ai/code/session_01KefahWkEG7rViphChTTmky\nfoo";
  assert.deepEqual(C.extractSessionLinks(body), ["session_01KefahWkEG7rViphChTTmky"]);
  assert.equal(C.sessionIdFromUrl("https://claude.ai/code/session_01KefahWkEG7rViphChTTmky?m=0"), "session_01KefahWkEG7rViphChTTmky");
  assert.equal(C.sessionIdFromUrl("https://claude.ai/chat/abc"), null);
  assert.equal(C.sessionIdFromUrl("https://evil.com/code/session_01KefahWkEG7rViphChTTmky"), null);
});

test("normalizeRepo", () => {
  assert.equal(C.normalizeRepo("https://github.com/Adam/Repo.git"), "adam/repo");
  assert.equal(C.normalizeRepo("git@github.com:adam/repo.git"), "adam/repo");
  assert.equal(C.normalizeRepo("adam/repo"), "adam/repo");
  assert.equal(C.normalizeRepo("nope"), null);
});

test("summarizeApiSession pulls repo and outcome branches", () => {
  const s = C.summarizeApiSession({
    id: "session_abcdefgh12",
    title: "Fix bug",
    session_status: "idle",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    session_context: {
      sources: [{ type: "git_repository", url: "https://github.com/acme/web", revision: "main" }],
      outcomes: [{ type: "git_repository", git_info: { type: "github", repo: "acme/web", branches: ["claude/fix-bug-x1"] } }],
    },
  });
  assert.deepEqual(s.repos, ["acme/web"]);
  assert.deepEqual(s.branches, ["claude/fix-bug-x1"]);
  assert.equal(s.status, "idle");
});

test("classifyEventPrRefs marks PR creation", () => {
  const created = C.classifyEventPrRefs(
    JSON.stringify({ type: "tool_result", name: "mcp__github__create_pull_request", url: "https://github.com/a/b/pull/1" }),
  );
  assert.equal(created[0].kind, "created");
  const mentioned = C.classifyEventPrRefs(JSON.stringify({ text: "look at https://github.com/a/b/pull/2" }));
  assert.equal(mentioned[0].kind, "mentioned");
});

test("addRelation keeps the strongest kind and merges sources", () => {
  const db = C.emptyDb();
  const ref = { owner: "Acme", repo: "Web", number: 5 };
  C.addRelation(db, "session_aaaaaaaaaa", ref, "mentioned", "claude-page", 1);
  C.addRelation(db, "session_aaaaaaaaaa", ref, "created", "claude-api", 2);
  C.addRelation(db, "session_aaaaaaaaaa", ref, "mentioned", "claude-api", 3);
  const rel = db.prs["acme/web#5"].sessions.session_aaaaaaaaaa;
  assert.equal(rel.kind, "created");
  assert.deepEqual(rel.sources, ["claude-page", "claude-api"]);
  assert.equal(rel.firstSeen, 1);
  assert.equal(rel.lastSeen, 3);
});

test("findSessionsForPr matches by stored relation and by head branch", () => {
  const db = C.emptyDb();
  C.upsertSession(db, { id: "session_branch0001", title: "Branch", repos: ["acme/web"], branches: ["claude/x"], updatedAt: "2026-01-01" });
  C.upsertSession(db, { id: "session_other00001", title: "Other repo", repos: ["acme/api"], branches: ["claude/x"] });
  C.upsertSession(db, { id: "session_mention001", title: "Mention", updatedAt: "2026-02-01" });
  C.addRelation(db, "session_mention001", { owner: "acme", repo: "web", number: 9 }, "mentioned", "claude-api");

  const found = C.findSessionsForPr(db, { owner: "ACME", repo: "web", number: 9, headBranch: "claude/x" });
  assert.deepEqual(found.map((f) => [f.id, f.kind]), [
    ["session_branch0001", "branch"],
    ["session_mention001", "mentioned"],
  ]);
  assert.equal(found[0].url, "https://claude.ai/code/session_branch0001");

  const noBranch = C.findSessionsForPr(db, { owner: "acme", repo: "web", number: 9, headBranch: "claude/x" }, { matchBranch: false });
  assert.deepEqual(noBranch.map((f) => f.id), ["session_mention001"]);
});

test("upsertSession merges arrays and ignores nulls", () => {
  const db = C.emptyDb();
  C.upsertSession(db, { id: "session_zzzzzzzzzz", title: "A", branches: ["b1"] }, 1);
  C.upsertSession(db, { id: "session_zzzzzzzzzz", title: null, branches: ["b2"] }, 2);
  const s = db.sessions.session_zzzzzzzzzz;
  assert.equal(s.title, "A");
  assert.deepEqual(s.branches, ["b1", "b2"]);
  assert.equal(s.firstSeen, 1);
});

test("listRelations flattens newest first", () => {
  const db = C.emptyDb();
  C.addRelation(db, "session_one0000001", { owner: "a", repo: "b", number: 1 }, "created", "x", 10);
  C.addRelation(db, "session_two0000002", { owner: "a", repo: "b", number: 2 }, "branch", "x", 20);
  const rows = C.listRelations(db);
  assert.deepEqual(rows.map((r) => r.number), [2, 1]);
  assert.equal(rows[0].prUrl, "https://github.com/a/b/pull/2");
});
