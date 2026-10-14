const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  appSessionsDir,
  listAppSessionFiles,
  listSessionFiles,
  parseAppSessionFile,
  parseSessionFile,
  scanAppSessions,
  scanProjects,
} = require("../host/scan.js");

const SID = "11111111-2222-3333-4444-555555555555";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cgl-scan-"));
}

function line(obj) {
  return JSON.stringify({ sessionId: SID, timestamp: "2026-10-01T10:00:00Z", ...obj }) + "\n";
}

const user = (content, extra = {}) => line({ type: "user", cwd: "/w", message: { role: "user", content }, ...extra });
const assistant = (content, extra = {}) => line({ type: "assistant", cwd: "/w", message: { role: "assistant", content }, ...extra });
const prLink = (url, extra = {}) => line({ type: "pr-link", prUrl: url, prNumber: Number(url.split("/").pop()), ...extra });

test("parseSessionFile reads cwd, title and the pr-link entries", async () => {
  const root = tmp();
  const file = path.join(root, `${SID}.jsonl`);
  fs.writeFileSync(
    file,
    [
      user("<command-name>/clear</command-name>"),
      user("Fix the login bug please"),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/acme/web/pull/10\n" }]),
      prLink("https://github.com/Acme/Web/pull/10"),
      prLink("https://github.com/acme/web/pull/10"),
      assistant([{ type: "text", text: "Related: https://github.com/acme/web/pull/5" }], { timestamp: "2026-10-01T11:00:00Z" }),
      prLink("https://github.com/acme/api/pull/7"),
      prLink("not a url"),
      line({ type: "summary", summary: "Fix login bug" }),
    ].join(""),
  );
  const r = await parseSessionFile(file);
  assert.equal(r.session.id, SID);
  assert.equal(r.session.cwd, "/w");
  assert.equal(r.session.title, "Fix login bug");
  assert.equal(r.session.firstPrompt, "Fix the login bug please");
  assert.equal(r.session.updatedAt, "2026-10-01T11:00:00Z");
  // Only pr-link entries count: URLs in tool results or messages do not, and repeats collapse.
  assert.deepEqual(r.prs, [
    { owner: "acme", repo: "web", number: 10, kind: "linked" },
    { owner: "acme", repo: "api", number: 7, kind: "linked" },
  ]);
  assert.equal(r.end, fs.statSync(file).size);
});

test("scanProjects is incremental and re-reads half-written lines", async () => {
  const root = tmp();
  const proj = path.join(root, "-work");
  fs.mkdirSync(proj);
  fs.mkdirSync(path.join(proj, SID)); // subagent dir: ignored
  fs.writeFileSync(path.join(proj, SID, "agent.jsonl"), user("x"));
  const file = path.join(proj, `${SID}.jsonl`);
  fs.writeFileSync(file, user("first prompt"));
  assert.deepEqual(listSessionFiles(root), [file]);

  const known = {};
  const seen = [];
  const collect = (f, stat, parsed, start) => {
    known[f] = stat;
    seen.push({ start, parsed });
  };

  await scanProjects(root, known, collect);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].parsed.session.firstPrompt, "first prompt");

  // Unchanged → nothing to do.
  const res = await scanProjects(root, known, collect);
  assert.equal(res.changed, 0);
  assert.equal(seen.length, 1);

  // Append one full line and half of the next.
  const half = prLink("https://github.com/acme/web/pull/8");
  fs.appendFileSync(file, prLink("https://github.com/acme/web/pull/7") + half.slice(0, 30));
  await scanProjects(root, known, collect);
  assert.equal(seen.length, 2);
  assert.ok(seen[1].start > 0, "second scan starts where the first stopped");
  assert.equal(seen[1].parsed.session.firstPrompt, null, "delta scans do not guess the first prompt");
  assert.deepEqual(seen[1].parsed.prs.map((p) => p.number), [7]);

  // Finish the half line → it is picked up.
  fs.appendFileSync(file, half.slice(30));
  await scanProjects(root, known, collect);
  assert.deepEqual(seen[2].parsed.prs.map((p) => p.number), [8]);
  assert.equal(known[file].size, fs.statSync(file).size);
});

function appSession(root, name, data) {
  const dir = path.join(root, "account", "org");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

test("parseAppSessionFile maps the app's PRs to the CLI session", () => {
  const root = tmp();
  const file = appSession(root, "local_a.json", {
    sessionId: "local_a",
    cliSessionId: SID,
    cwd: "/w",
    title: "Renamed in the app",
    prUrl: "https://github.com/acme/web/pull/3",
    prs: [
      { prNumber: 3, url: "https://github.com/acme/web/pull/3", branch: "claude/x", state: "MERGED" },
      { prNumber: 4, url: "https://github.com/acme/web/pull/4", branch: "claude/y", state: "OPEN" },
    ],
  });
  assert.deepEqual(parseAppSessionFile(file), {
    session: { id: SID, cwd: "/w", appTitle: "Renamed in the app" },
    prs: [
      { owner: "acme", repo: "web", number: 3, kind: "linked" },
      { owner: "acme", repo: "web", number: 4, kind: "linked" },
    ],
  });
  assert.equal(parseAppSessionFile(appSession(root, "local_b.json", { sessionId: "local_b", cwd: "/w" })), null);
  fs.writeFileSync(path.join(root, "broken.json"), "{");
  assert.equal(parseAppSessionFile(path.join(root, "broken.json")), null);
});

test("scanAppSessions only re-reads changed files", async () => {
  const root = tmp();
  const file = appSession(root, "local_a.json", { cliSessionId: SID, prs: [] });
  appSession(root, "local_b.json", { sessionId: "local_b" });
  assert.equal(listAppSessionFiles(root).length, 2);

  const known = {};
  const seen = [];
  const collect = (f, stat, parsed) => {
    known[f] = stat;
    seen.push(parsed);
  };
  assert.deepEqual(await scanAppSessions(root, known, collect), { files: 2, changed: 1 });
  assert.equal(seen.length, 2, "files without a CLI session are remembered too");

  assert.deepEqual(await scanAppSessions(root, known, collect), { files: 2, changed: 0 });

  fs.writeFileSync(file, JSON.stringify({ cliSessionId: SID, prs: [{ url: "https://github.com/acme/web/pull/9" }] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  await scanAppSessions(root, known, collect);
  assert.deepEqual(seen.at(-1).prs.map((p) => p.number), [9]);
});

test("appSessionsDir follows the platform and the override", () => {
  assert.equal(appSessionsDir({ CLAUDE_APP_SESSIONS_DIR: "/x" }), "/x");
  assert.equal(
    appSessionsDir({}, "darwin"),
    path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  );
  assert.equal(appSessionsDir({ APPDATA: "C:\\AppData" }, "win32"), path.join("C:\\AppData", "Claude", "claude-code-sessions"));
});
