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

test("extractSessionLinks", () => {
  const body = "Claude-Session: https://claude.ai/code/session_01KefahWkEG7rViphChTTmky\nfoo";
  assert.deepEqual(C.extractSessionLinks(body), ["session_01KefahWkEG7rViphChTTmky"]);
});

test("sessionLink opens local sessions in the Claude app", () => {
  const local = C.sessionLink({ id: "cac1984e-66bd-5015-a04a-a43bcf158e80", cwd: "/Users/me/my repo" });
  assert.equal(local.app, true);
  assert.equal(local.url, "claude://resume?session=cac1984e-66bd-5015-a04a-a43bcf158e80&cwd=%2FUsers%2Fme%2Fmy+repo");
  const parsed = new URL(local.url);
  assert.equal(parsed.searchParams.get("cwd"), "/Users/me/my repo");

  const cloud = C.sessionLink({ id: "session_01KefahWkEG7rViphChTTmky" });
  assert.deepEqual(cloud, { url: "https://claude.ai/code/session_01KefahWkEG7rViphChTTmky", app: false });
});

test("sessionTitle prefers the Claude app's title, then the transcript's, then the first prompt", () => {
  assert.equal(C.sessionTitle({ appTitle: "A", title: "T", firstPrompt: "P" }), "A");
  assert.equal(C.sessionTitle({ title: "T", firstPrompt: "P" }), "T");
  assert.equal(C.sessionTitle({ firstPrompt: "P" }), "P");
  assert.equal(C.sessionTitle({}), null);
});

test("addRelation keeps the strongest kind and merges sources", () => {
  const db = C.emptyDb();
  const ref = { owner: "Acme", repo: "Web", number: 5 };
  C.addRelation(db, "session_aaaaaaaaaa", ref, "backlink", "github-page", 1);
  C.addRelation(db, "session_aaaaaaaaaa", ref, "linked", "local", 2);
  C.addRelation(db, "session_aaaaaaaaaa", ref, "backlink", "github-page", 3);
  const rel = db.prs["acme/web#5"].sessions.session_aaaaaaaaaa;
  assert.equal(rel.kind, "linked");
  assert.deepEqual(rel.sources, ["github-page", "local"]);
  assert.equal(rel.firstSeen, 1);
  assert.equal(rel.lastSeen, 3);
});

test("findSessionsForPr returns stored relations, strongest first", () => {
  const db = C.emptyDb();
  C.upsertSession(db, { id: "session_backlink01", title: "Backlink", updatedAt: "2026-02-01" });
  C.upsertSession(db, { id: "session_linked0001", title: "Linked", updatedAt: "2026-01-01" });
  C.addRelation(db, "session_backlink01", { owner: "acme", repo: "web", number: 9 }, "backlink", "github-page");
  C.addRelation(db, "session_linked0001", { owner: "acme", repo: "web", number: 9 }, "linked", "local");
  C.addRelation(db, "session_linked0001", { owner: "acme", repo: "web", number: 10 }, "linked", "local");

  const found = C.findSessionsForPr(db, { owner: "ACME", repo: "web", number: 9 });
  assert.deepEqual(found.map((f) => [f.id, f.kind]), [
    ["session_linked0001", "linked"],
    ["session_backlink01", "backlink"],
  ]);
  assert.equal(found[0].title, "Linked");
  assert.equal(found[0].url, "https://claude.ai/code/session_linked0001");
  assert.equal(found[0].app, false);
  assert.deepEqual(C.findSessionsForPr(db, { owner: "acme", repo: "web", number: 11 }), []);
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
  C.addRelation(db, "session_one0000001", { owner: "a", repo: "b", number: 1 }, "linked", "x", 10);
  C.addRelation(db, "session_two0000002", { owner: "a", repo: "b", number: 2 }, "backlink", "x", 20);
  const rows = C.listRelations(db);
  assert.deepEqual(rows.map((r) => r.number), [2, 1]);
  assert.equal(rows[0].prUrl, "https://github.com/a/b/pull/2");
});

test("findSessionsForPr ranks app sessions above web ones of the same kind", () => {
  const db = C.emptyDb();
  C.upsertSession(db, { id: "session_cloud00001", updatedAt: "2026-09-02" });
  C.upsertSession(db, { id: "0b1c2d3e-0000-0000-0000-000000000000", cwd: "/w", updatedAt: "2026-09-01" });
  C.addRelation(db, "session_cloud00001", { owner: "a", repo: "b", number: 1 }, "linked", "x");
  C.addRelation(db, "0b1c2d3e-0000-0000-0000-000000000000", { owner: "a", repo: "b", number: 1 }, "linked", "local");
  const found = C.findSessionsForPr(db, { owner: "a", repo: "b", number: 1 });
  assert.deepEqual(found.map((f) => f.app), [true, false]);
  assert.match(found[0].url, /^claude:\/\/resume\?session=0b1c2d3e/);
});
