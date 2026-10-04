const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseSessionFile, scanProjects, listSessionFiles } = require("../host/scan.js");

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
  assert.deepEqual(r.session.branches.sort(), ["claude/feature", "main"]);
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
