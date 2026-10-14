const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { extensionId } = require("../host/install.js");

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(body.length);
  return Buffer.concat([h, body]);
}

function talk(env, messages, untilType) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "host", "claude-link-host.js")], {
      env: { ...process.env, ...env },
    });
    const out = [];
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        const msg = JSON.parse(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
        out.push(msg);
        if (msg.type === untilType) child.stdin.end();
      }
    });
    child.on("error", reject);
    child.on("exit", () => resolve(out));
    for (const m of messages) child.stdin.write(frame(m));
  });
}

test("native host answers ping and streams a scan", async () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "cgl-host-"));
  const proj = path.join(config, "projects", "-w");
  fs.mkdirSync(proj, { recursive: true });
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  fs.writeFileSync(
    path.join(proj, `${id}.jsonl`),
    JSON.stringify({ type: "user", sessionId: id, cwd: "/w", message: { content: "hi" } }) +
      "\n" +
      JSON.stringify({ type: "pr-link", sessionId: id, prNumber: 3, prUrl: "https://github.com/a/b/pull/3" }) +
      "\n",
  );
  const appDir = path.join(config, "app", "acct", "org");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "local_x.json"),
    JSON.stringify({ cliSessionId: id, title: "From the app", prs: [{ url: "https://github.com/a/b/pull/4" }] }),
  );
  const env = { CLAUDE_CONFIG_DIR: config, CLAUDE_APP_SESSIONS_DIR: path.join(config, "app") };
  const out = await talk(env, [{ type: "ping" }, { type: "scan", known: {} }], "done");
  assert.equal(out[0].type, "pong");
  assert.equal(out[0].projectsDir, path.join(config, "projects"));
  assert.equal(out[0].appSessionsDir, path.join(config, "app"));
  assert.equal(out[1].type, "session");
  assert.equal(out[1].session.id, id);
  assert.deepEqual(out[1].prs, [{ owner: "a", repo: "b", number: 3, kind: "linked" }]);
  assert.equal(out[2].type, "session");
  assert.deepEqual(out[2].session, { id, cwd: null, appTitle: "From the app" });
  assert.deepEqual(out[2].prs, [{ owner: "a", repo: "b", number: 4, kind: "linked" }]);
  assert.equal(out[3].type, "done");
  assert.equal(out[3].changed, 2);
});

test("extension id is derived from the manifest key", () => {
  assert.match(extensionId(), /^[a-p]{32}$/);
});
