/*
 * End-to-end test: loads the unpacked extension into Chromium with the real
 * native host registered against a fixture ~/.claude, serves fake github.com
 * pages through request interception, and checks that local sessions are
 * picked up (including incrementally) and PR pages get Claude app deep links.
 *
 *   npm run test:e2e            (needs Playwright + Chromium + git)
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
const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001"; // opened PR #11 with gh pr create
const SESSION_B = "bbbbbbbb-0000-4000-8000-000000000002"; // worked on claude/branch-b
const SESSION_C = "session_01E2eBacklink000000003"; // cloud session, only linked from PR #12 body

const jsonl = (sessionId, cwd, entries) =>
  entries.map((e) => JSON.stringify({ sessionId, cwd, timestamp: "2026-10-01T10:00:00Z", ...e })).join("\n") + "\n";

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
  const cwd = path.join(tmp, "work", "web");
  const shotsDir = process.env.E2E_SCREENSHOTS;

  // A git checkout of acme/web and two local Claude Code transcripts for it.
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/acme/web.git"]);
  const proj = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, `${SESSION_A}.jsonl`),
    jsonl(SESSION_A, cwd, [
      { type: "user", gitBranch: "main", message: { role: "user", content: "Add a dark mode toggle" } },
      { type: "assistant", gitBranch: "claude/dark-mode", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } }] } },
      { type: "user", gitBranch: "claude/dark-mode", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/acme/web/pull/11\n" }] } },
      { type: "summary", summary: "Add dark mode" },
    ]),
  );
  const fileB = path.join(proj, `${SESSION_B}.jsonl`);
  fs.writeFileSync(
    fileB,
    jsonl(SESSION_B, cwd, [{ type: "user", gitBranch: "claude/branch-b", message: { role: "user", content: "Fix the flaky login test" } }]),
  );

  // Register the native host inside the test profile only.
  execFileSync(process.execPath, [
    path.join(ROOT, "host", "install.js"),
    "--target-dir",
    path.join(userDataDir, "NativeMessagingHosts"),
    "--bin-dir",
    path.join(tmp, "bin"),
  ], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: "ignore" });

  const executablePath = fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
    : undefined;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    args: ["--headless=new", `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--no-sandbox"],
    viewport: { width: 1100, height: 420 },
  });
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
    return d && d.sessions[SESSION_B] && d.prs["acme/web#11"] && d;
  }, "first scan").catch(async (e) => {
    console.error("last scan result:", await lastResult());
    throw e;
  });
  assert.equal(db.prs["acme/web#11"].sessions[SESSION_A].kind, "created");
  assert.equal(db.sessions[SESSION_A].cwd, cwd);
  assert.deepEqual(db.sessions[SESSION_A].repos, ["acme/web"]);
  assert.deepEqual(db.sessions[SESSION_B].branches, ["claude/branch-b"]);
  console.log("✓ local sessions read through the native host");

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

  // 3. Branch-only match.
  await gh.goto("https://github.com/acme/web/pull/13");
  await gh.locator(".cgl-chip").waitFor({ timeout: 10000 });
  assert.match(await gh.locator(".cgl-chip").getAttribute("href"), new RegExp(`^claude://resume\\?session=${SESSION_B}`));
  console.log("✓ PR matched by head branch");

  // 4. Cloud-session backlink falls back to claude.ai.
  await gh.goto("https://github.com/acme/web/pull/12");
  await gh.locator(".cgl-chip").waitFor({ timeout: 10000 });
  assert.equal(await gh.locator(".cgl-chip").getAttribute("href"), `https://claude.ai/code/${SESSION_C}`);
  assert.equal(await gh.locator(".cgl-chip").getAttribute("target"), "_blank");
  console.log("✓ cloud session backlink links to claude.ai");

  // 5. Polling picks up new lines appended to a running session.
  fs.appendFileSync(
    fileB,
    jsonl(SESSION_B, cwd, [
      { type: "assistant", gitBranch: "claude/branch-b", message: { content: [{ type: "text", text: "Opened a PR: https://github.com/acme/web/pull/14" }] } },
    ]),
  );
  await worker.evaluate(() => poll()); // what the 30 s alarm does
  db = await waitFor(async () => {
    const d = await getDb();
    return d.prs["acme/web#14"] && d;
  }, "incremental scan");
  assert.equal(db.prs["acme/web#14"].sessions[SESSION_B].kind, "created");
  await gh.goto("https://github.com/acme/web/pull/14");
  await gh.locator(".cgl-chip").waitFor({ timeout: 10000 });
  console.log("✓ polling picked up an appended transcript line");

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

  await context.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("e2e passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
