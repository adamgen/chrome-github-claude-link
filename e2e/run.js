/*
 * End-to-end test: loads the unpacked extension into Chromium with the real
 * native host registered against a fixture ~/.claude, serves fake github.com
 * pages through request interception, and checks that local sessions are
 * picked up (including incrementally) and PR pages get Claude app deep links.
 *
 *   npm run test:e2e            (needs Playwright + Chromium)
 *   E2E_SCREENSHOTS=dir npm run test:e2e
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (_) {
    const root = execFileSync("npm", ["root", "-g"]).toString().trim();
    return require(path.join(root, "playwright"));
  }
}

const ROOT = path.resolve(__dirname, "..");
const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001"; // transcript has a pr-link entry for PR #11
const SESSION_B = "bbbbbbbb-0000-4000-8000-000000000002"; // the Claude app's session file lists PR #13
const SESSION_C = "session_01E2eBacklink000000003"; // cloud session, only linked from PR #12 body
const SESSION_NOISE = "cccccccc-0000-4000-8000-000000000004"; // PR URLs in its messages, but no pr-link entry

const jsonl = (sessionId, cwd, entries) =>
  entries.map((e) => JSON.stringify({ sessionId, cwd, timestamp: "2026-10-01T10:00:00Z", ...e })).join("\n") + "\n";
const prLink = (number) => ({ type: "pr-link", prNumber: number, prUrl: `https://github.com/acme/web/pull/${number}`, prRepository: "acme/web" });

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const prPage = (number, title, head, body = "") =>
  html(
    `${title} · Pull Request #${number} · acme/web`,
    `<main><div id="partial-discussion-header" class="gh-header">
       <div class="gh-header-show"><h1 class="gh-header-title">${title} <span>#${number}</span></h1></div>
       <div class="gh-header-meta">wants to merge 1 commit into <span class="commit-ref base-ref">main</span>
         from <span class="commit-ref head-ref" title="acme/web:${head}">${head}</span></div>
     </div><div class="js-discussion"><div class="markdown-body">${body}</div></div></main>`,
  );

const githubPages = {
  "/acme/web/pull/11": prPage(11, "Add dark mode", "claude/dark-mode"),
  "/acme/web/pull/12": prPage(12, "Refactor", "feature/refactor", `<p>Generated in <a href="https://claude.ai/code/${SESSION_C}">a session</a></p>`),
  "/acme/web/pull/13": prPage(13, "Fix flaky login test", "claude/branch-b"),
  "/acme/web/pull/14": prPage(14, "Follow-up", "feature/follow-up"),
  "/acme/web/pulls": html(
    "Pull requests · acme/web",
    `<main>${[11, 12, 99]
      .map((n) => `<div class="Box-row"><a class="Link--primary" data-hovercard-type="pull_request" href="/acme/web/pull/${n}">PR ${n}</a></div>`)
      .join("")}</main>`,
  ),
};

async function waitFor(fn, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const { chromium } = loadPlaywright();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgl-e2e-"));
  const userDataDir = path.join(tmp, "profile");
  const configDir = path.join(tmp, "claude-config");
  const appSessionsDir = path.join(tmp, "claude-app", "claude-code-sessions");
  const cwd = path.join(tmp, "work", "web");
  const shotsDir = process.env.E2E_SCREENSHOTS;

  // A checkout of acme/web, local Claude Code transcripts for it, and the
  // Claude app's metadata for one of them.
  fs.mkdirSync(cwd, { recursive: true });
  const proj = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, `${SESSION_A}.jsonl`),
    jsonl(SESSION_A, cwd, [
      { type: "user", message: { role: "user", content: "Add a dark mode toggle" } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/acme/web/pull/11\n" }] } },
      prLink(11),
      { type: "summary", summary: "Add dark mode" },
    ]),
  );
  const fileB = path.join(proj, `${SESSION_B}.jsonl`);
  fs.writeFileSync(
    fileB,
    jsonl(SESSION_B, cwd, [{ type: "user", message: { role: "user", content: "Fix the flaky login test" } }]),
  );
  fs.mkdirSync(path.join(appSessionsDir, "acct", "org"), { recursive: true });
  fs.writeFileSync(
    path.join(appSessionsDir, "acct", "org", "local_b.json"),
    JSON.stringify({
      sessionId: "local_b",
      cliSessionId: SESSION_B,
      cwd,
      title: "Flaky login test",
      prs: [{ prNumber: 13, url: "https://github.com/acme/web/pull/13", branch: "claude/branch-b", state: "OPEN" }],
    }),
  );
  // Noise that must NOT be linked: PR URLs in tool output and messages, with no pr-link entry.
  fs.writeFileSync(
    path.join(proj, `${SESSION_NOISE}.jsonl`),
    jsonl(SESSION_NOISE, cwd, [
      { type: "user", message: { role: "user", content: "What does https://github.com/acme/web/pull/13 change?" } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "l1", name: "Bash", input: { command: "gh pr list" } }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "l1", content: [11, 12, 13, 14].map((n) => `https://github.com/acme/web/pull/${n}`).join("\n") }] },
      },
    ]),
  );

  // Register the native host inside the test profile only.
  execFileSync(process.execPath, [
    path.join(ROOT, "host", "install.js"),
    "--target-dir",
    path.join(userDataDir, "NativeMessagingHosts"),
    "--bin-dir",
    path.join(tmp, "bin"),
  ], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_APP_SESSIONS_DIR: appSessionsDir }, stdio: "ignore" });

  const executablePath = fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
    : undefined;
  const launch = () =>
    chromium.launchPersistentContext(userDataDir, {
      headless: false,
      executablePath,
      args: ["--headless=new", `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--no-sandbox"],
      viewport: { width: 1100, height: 420 },
    });
  let context = await launch();
  await context.route("https://github.com/**", async (route) => {
    const body = githubPages[new URL(route.request().url()).pathname];
    return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "not found" });
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extId = new URL(worker.url()).host;
  const getDb = () => worker.evaluate(async () => (await chrome.storage.local.get("db")).db);
  const lastResult = () => worker.evaluate(async () => ((await chrome.storage.local.get("scan")).scan || {}).lastResult);

  // 1. The first scan runs on install, without any click.
  let db = await waitFor(async () => {
    const d = await getDb();
    return d && d.prs["acme/web#13"] && d.prs["acme/web#11"] && d;
  }, "first scan").catch(async (e) => {
    console.error("last scan result:", await lastResult());
    throw e;
  });
  assert.equal(db.prs["acme/web#11"].sessions[SESSION_A].kind, "linked");
  assert.equal(db.prs["acme/web#13"].sessions[SESSION_B].kind, "linked");
  assert.ok(!Object.values(db.prs).some((p) => p.sessions[SESSION_NOISE]), "PR URLs without a pr-link entry are not linked");
  assert.equal(db.sessions[SESSION_A].cwd, cwd);
  assert.equal(db.sessions[SESSION_B].appTitle, "Flaky login test");
  console.log("✓ local sessions and Claude app metadata read through the native host");

  // 2. PR page links to the session with a Claude app deep link.
  const expectedA = `claude://resume?session=${SESSION_A}&cwd=${encodeURIComponent(cwd)}`;
  const gh = await context.newPage();
  await gh.goto("https://github.com/acme/web/pull/11");
  const chip = gh.locator(".gh-header-title .cgl-chip");
  await chip.waitFor({ timeout: 10000 });
  assert.equal(await chip.getAttribute("href"), expectedA);
  assert.equal(await chip.getAttribute("target"), null, "app links must not open a blank tab");
  assert.match(await chip.innerText(), /Open in Claude[\s·]*Add dark mode/);
  if (shotsDir) await gh.screenshot({ path: path.join(shotsDir, "pr-page.png") });
  console.log("✓ PR page has a claude://resume deep link");

  // 3. PR linked only by the Claude app's metadata.
  await gh.goto("https://github.com/acme/web/pull/13");
  await gh.locator(".cgl-chip").waitFor({ timeout: 10000 });
  assert.match(await gh.locator(".cgl-chip").getAttribute("href"), new RegExp(`^claude://resume\\?session=${SESSION_B}`));
  assert.match(await gh.locator(".cgl-chip").innerText(), /Flaky login test/);
  assert.equal(await gh.locator(".cgl-more").count(), 0, "the chat that only mentioned the PR is not linked");
  console.log("✓ PR linked from the Claude app's session metadata, mentions ignored");

  // 4. Cloud-session backlink falls back to claude.ai.
  await gh.goto("https://github.com/acme/web/pull/12");
  await gh.locator(".cgl-chip").waitFor({ timeout: 10000 });
  assert.equal(await gh.locator(".cgl-chip").getAttribute("href"), `https://claude.ai/code/${SESSION_C}`);
  assert.equal(await gh.locator(".cgl-chip").getAttribute("target"), "_blank");
  console.log("✓ cloud session backlink links to claude.ai");

  // 5. No clicks, no reloads: an already-open PR page updates on its own once
  //    the 30 s alarm picks up a line appended to a running session.
  await gh.goto("https://github.com/acme/web/pull/14");
  await gh.waitForTimeout(1500);
  assert.equal(await gh.locator(".cgl-chip").count(), 0, "PR #14 has no session yet");
  const appendedAt = Date.now();
  fs.appendFileSync(fileB, jsonl(SESSION_B, cwd, [prLink(14)]));
  await gh.locator(".cgl-chip").waitFor({ timeout: 75000 });
  db = await getDb();
  assert.equal(db.prs["acme/web#14"].sessions[SESSION_B].kind, "linked");
  console.log(`✓ open PR page updated by itself ${Math.round((Date.now() - appendedAt) / 1000)}s after the transcript changed`);

  // 5b. If Chrome drops the alarm, opening a GitHub page restores it and rescans.
  await worker.evaluate(async () => {
    await chrome.alarms.clearAll();
    const { scan } = await chrome.storage.local.get("scan");
    scan.lastResult.at = 0; // pretend the last check was long ago
    await chrome.storage.local.set({ scan });
  });
  fs.appendFileSync(fileB, jsonl(SESSION_B, cwd, [prLink(15)]));
  await gh.goto("https://github.com/acme/web/pull/13");
  await waitFor(async () => (await getDb()).prs["acme/web#15"], "rescan triggered by a GitHub page");
  await waitFor(() => worker.evaluate(async () => !!(await chrome.alarms.get("cgl-poll"))), "alarm recreated");
  console.log("✓ lost alarm recovered; GitHub page triggered a fresh scan");

  // 6. PR list annotations.
  await gh.goto("https://github.com/acme/web/pulls");
  await gh.locator(".cgl-inline").nth(1).waitFor({ timeout: 10000 });
  const inline = await gh.locator(".cgl-inline").evaluateAll((els) =>
    els.map((e) => [e.previousElementSibling.getAttribute("href"), e.getAttribute("href")]),
  );
  assert.deepEqual(inline, [
    ["/acme/web/pull/11", expectedA],
    ["/acme/web/pull/12", `https://claude.ai/code/${SESSION_C}`],
  ]);
  if (shotsDir) await gh.screenshot({ path: path.join(shotsDir, "pr-list.png") });
  console.log("✓ PR list links annotated");

  // 7. Popup shows status and relations, no sync button.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 424, height: 560 });
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await popup.locator("#list li").nth(3).waitFor();
  await popup.locator("#live.ok").waitFor();
  assert.equal(await popup.locator("#setup").isHidden(), true);
  if (shotsDir) await popup.screenshot({ path: path.join(shotsDir, "popup.png") });
  console.log("✓ popup lists relations");

  // 8. Upgrading (then restarting Chrome): links stored under the old rules are
  //    dropped and rebuilt, and the branch/mention switches are removed.
  await worker.evaluate(async () => {
    const { db } = await chrome.storage.local.get("db");
    db.version = 2;
    db.prs["acme/web#500"] = { owner: "acme", repo: "web", number: 500, sessions: { stale: { kind: "branch", sources: ["local"] } } };
    await chrome.storage.local.set({ db, settings: { pollSeconds: 30, matchBranch: true, showMentioned: true, version: 2 } });
  });
  await context.close();
  context = await launch();
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const readStorage = (key) => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
  db = await waitFor(async () => {
    const d = await readStorage("db");
    return d && d.version === 3 && d.prs["acme/web#11"] && d;
  }, "rebuilt db after upgrade");
  assert.equal(db.prs["acme/web#500"], undefined, "stale relation dropped");
  const settings = await readStorage("settings");
  assert.equal(settings.showMentioned, undefined, "showMentioned removed");
  assert.equal(settings.matchBranch, undefined, "matchBranch removed");
  console.log("✓ upgrade drops old links and rebuilds them with the new rules");

  await context.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("e2e passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
