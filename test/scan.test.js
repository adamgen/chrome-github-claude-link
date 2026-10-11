const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseSessionFile, scanProjects, listSessionFiles, pushedBranches, createdPr } = require("../host/scan.js");

const SID = "11111111-2222-3333-4444-555555555555";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cgl-scan-"));
}

function line(obj) {
  return JSON.stringify({ sessionId: SID, timestamp: "2026-10-01T10:00:00Z", ...obj }) + "\n";
}

function gitRepo(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
}

const user = (content, extra = {}) => line({ type: "user", cwd: "/nope", gitBranch: "main", message: { role: "user", content }, ...extra });
const assistant = (content, extra = {}) => line({ type: "assistant", cwd: "/nope", gitBranch: "claude/feature", message: { role: "assistant", content }, ...extra });

test("parseSessionFile extracts cwd, repo, branches, title and PRs", async () => {
  const root = tmp();
  const cwd = path.join(root, "work");
  gitRepo(cwd, "git@github.com:Acme/Web.git");
  const file = path.join(root, `${SID}.jsonl`);
  fs.writeFileSync(
    file,
    [
      line({ type: "queue-operation", content: "https://github.com/acme/web/pull/1" }),
      line({ type: "attachment", cwd, attachment: { text: "see https://github.com/acme/web/pull/2" } }),
      user("<command-name>/clear</command-name>", { cwd }),
      user("Fix the login bug please", { cwd }),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } }], { cwd }),
      user([{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/acme/web/pull/10\n" }], { cwd }),
      assistant([{ type: "tool_use", id: "t2", name: "Write", input: { content: "https://github.com/acme/web/pull/3" } }], { cwd }),
      user([{ type: "tool_result", tool_use_id: "t2", content: "ok" }], { cwd }),
      assistant([{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "/x" } }], { cwd }),
      user([{ type: "tool_result", tool_use_id: "t3", content: "https://github.com/acme/web/pull/4" }], { cwd }),
      assistant([{ type: "text", text: "Related: https://github.com/acme/web/pull/5" }], { cwd, timestamp: "2026-10-01T11:00:00Z" }),
      line({ type: "summary", summary: "Fix login bug" }),
    ].join(""),
  );
  const r = await parseSessionFile(file);
  assert.equal(r.session.id, SID);
  assert.equal(r.session.cwd, cwd);
  assert.deepEqual(r.session.repos, ["acme/web"]);
  // Only the branch the session worked on; it merely sat on "main" while chatting.
  assert.deepEqual(r.session.branches, ["claude/feature"]);
  assert.equal(r.session.title, "Fix login bug");
  assert.equal(r.session.firstPrompt, "Fix the login bug please");
  assert.equal(r.session.updatedAt, "2026-10-01T11:00:00Z");
  assert.deepEqual(r.prs.map((p) => `${p.number}:${p.kind}`).sort(), ["10:created", "5:mentioned"]);
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
  const half = assistant([{ type: "text", text: "https://github.com/acme/web/pull/8" }]);
  fs.appendFileSync(file, assistant([{ type: "text", text: "Opened https://github.com/acme/web/pull/7" }]) + half.slice(0, 30));
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

test("a session that only had a branch checked out is not linked to it", async () => {
  const root = tmp();
  const file = path.join(root, `${SID}.jsonl`);
  const onFeature = { cwd: "/nope", gitBranch: "feature/busy" };
  fs.writeFileSync(
    file,
    [
      user("What does this function do?", onFeature),
      assistant([{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x" } }], onFeature),
      user([{ type: "tool_result", tool_use_id: "r1", content: "..." }], onFeature),
      assistant([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "git log --oneline -5" } }], onFeature),
      assistant([{ type: "text", text: "It parses the config." }], onFeature),
    ].join(""),
  );
  assert.deepEqual((await parseSessionFile(file)).session.branches, []);
});

test("edits, commits and pushes mark the branch as worked on", async () => {
  const root = tmp();
  const file = path.join(root, `${SID}.jsonl`);
  fs.writeFileSync(
    file,
    [
      assistant([{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x" } }], { gitBranch: "feat/edit" }),
      assistant([{ type: "tool_use", id: "c1", name: "Bash", input: { command: "git commit -am wip" } }], { gitBranch: "feat/commit" }),
      assistant([{ type: "tool_use", id: "p1", name: "Bash", input: { command: "git checkout -b feat/new && git push -u origin feat/new" } }], { gitBranch: "main" }),
    ].join(""),
  );
  assert.deepEqual((await parseSessionFile(file)).session.branches.sort(), ["feat/commit", "feat/edit", "feat/new", "main"]);
});

test("PR listings are not mentions", async () => {
  const root = tmp();
  const file = path.join(root, `${SID}.jsonl`);
  const list = [1, 2, 3, 4, 5].map((n) => `https://github.com/acme/web/pull/${n}`).join("\n");
  fs.writeFileSync(
    file,
    [
      assistant([{ type: "tool_use", id: "l1", name: "Bash", input: { command: "gh pr list --json url" } }]),
      user([{ type: "tool_result", tool_use_id: "l1", content: list }]),
      user("Can you review https://github.com/acme/web/pull/9 ?"),
    ].join(""),
  );
  assert.deepEqual((await parseSessionFile(file)).prs.map((p) => `${p.number}:${p.kind}`), ["9:mentioned"]);
});

test("pushedBranches reads push targets", () => {
  assert.deepEqual(pushedBranches("git push -u origin claude/x"), ["claude/x"]);
  assert.deepEqual(pushedBranches("git commit -m x && git push origin HEAD:feat/y"), ["feat/y"]);
  assert.deepEqual(pushedBranches("git push --force-with-lease origin +refs/heads/z"), ["z"]);
  assert.deepEqual(pushedBranches("git push"), []);
  assert.deepEqual(pushedBranches('git push origin "$BRANCH"'), []);
  assert.deepEqual(pushedBranches("git -C repo push origin fix/a"), ["fix/a"]);
  // Text that only contains "git push" (a script, a string literal) is not a push.
  assert.deepEqual(pushedBranches(`node -e 'run("git push -u origin x")'`), []);
  assert.deepEqual(pushedBranches("cat <<EOF\nexample: git push origin }],\nEOF"), []);
  assert.deepEqual(pushedBranches(`run(["git push origin HEAD:feat/y","git push --force origin x"])`), []);
  assert.deepEqual(pushedBranches(`x && git push origin a","git push origin b"])`), []);
});

test("createdPr takes the created PR's own URL, not links in its body", () => {
  const mcp = JSON.stringify([
    { type: "text", text: JSON.stringify({ body: "Follow-up to https://github.com/a/b/pull/1", html_url: "https://github.com/a/b/pull/9" }) },
  ]);
  assert.deepEqual(createdPr(mcp).map((r) => r.number), [9]);
  assert.deepEqual(createdPr(JSON.stringify("https://github.com/a/b/pull/7\n")).map((r) => r.number), [7]);
  assert.deepEqual(createdPr(JSON.stringify("no url")), []);
});
