/*
 * End-to-end smoke test: loads the unpacked extension into Chromium, serves
 * fake claude.ai and github.com pages/APIs through request interception, and
 * checks that a sync stores relations and the GitHub pages get deep links.
 *
 *   npm run test:e2e            (needs Playwright + Chromium)
 *   E2E_SCREENSHOTS=dir npm run test:e2e
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (_) {
    const { execSync } = require("node:child_process");
    const root = execSync("npm root -g").toString().trim();
    return require(path.join(root, "playwright"));
  }
}

const ROOT = path.resolve(__dirname, "..");
const SESSION_A = "session_01E2eOpenedPr0000000001"; // opened PR #11 via gh pr create
const SESSION_B = "session_01E2eBranchOnly00000002"; // pushed to claude/branch-b
const SESSION_C = "session_01E2eBacklink000000003"; // only linked from PR #12 body
const ORG = "org-e2e";

const sessionsApi = {
  data: [
    {
      id: SESSION_A,
      title: "Add dark mode",
      session_status: "idle",
      updated_at: "2026-09-29T10:00:00Z",
      session_context: {
        sources: [{ type: "git_repository", url: "https://github.com/acme/web" }],
        outcomes: [{ type: "git_repository", git_info: { type: "github", repo: "acme/web", branches: ["claude/dark-mode"] } }],
      },
    },
    {
      id: SESSION_B,
      title: "Fix flaky login test",
      session_status: "idle",
      updated_at: "2026-09-29T11:00:00Z",
      session_context: {
        sources: [{ type: "git_repository", url: "https://github.com/acme/web" }],
        outcomes: [{ type: "git_repository", git_info: { type: "github", repo: "acme/web", branches: ["claude/branch-b"] } }],
      },
    },
  ],
  has_more: false,
};

const eventsApi = {
  [SESSION_A]: {
    data: [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "gh pr create --fill" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "https://github.com/acme/web/pull/11" }] } },
    ],
    has_more: false,
  },
  [SESSION_B]: { data: [{ type: "assistant", message: { content: [{ type: "text", text: "Pushed." }] } }], has_more: false },
};

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const githubPages = {
  "/acme/web/pull/11": html(
    "Add dark mode by claude · Pull Request #11 · acme/web",
    `<main><div id="partial-discussion-header" class="gh-header">
       <div class="gh-header-show"><h1 class="gh-header-title">Add dark mode <span>#11</span></h1></div>
       <div class="gh-header-meta">claude wants to merge 1 commit into <span class="commit-ref base-ref">main</span>
         from <span class="commit-ref head-ref" title="acme/web:claude/dark-mode">claude/dark-mode</span></div>
     </div><div class="js-discussion"><div class="markdown-body">Adds dark mode.</div></div></main>`,
  ),
  "/acme/web/pull/12": html(
    "Refactor · Pull Request #12 · acme/web",
    `<main><div id="partial-discussion-header" class="gh-header">
       <div class="gh-header-show"><h1 class="gh-header-title">Refactor <span>#12</span></h1></div>
       <div class="gh-header-meta">wants to merge into <span class="commit-ref base-ref">main</span>
         from <span class="commit-ref head-ref">feature/refactor</span></div>
     </div><div class="js-discussion"><div class="markdown-body">
       <p>Generated in <a href="https://claude.ai/code/${SESSION_C}">https://claude.ai/code/${SESSION_C}</a></p>
     </div></div></main>`,
  ),
  "/acme/web/pull/13": html(
    "Flaky test · Pull Request #13 · acme/web",
    `<main><div id="partial-discussion-header" class="gh-header">
       <div class="gh-header-show"><h1 class="gh-header-title">Fix flaky login test <span>#13</span></h1></div>
       <div class="gh-header-meta">wants to merge into <span class="commit-ref base-ref">main</span>
         from <span class="commit-ref head-ref" title="acme/web:claude/branch-b">claude/branch-b</span></div>
     </div></main>`,
  ),
  "/acme/web/pulls": html(
    "Pull requests · acme/web",
    `<main><div class="js-navigation-container">
       <div class="Box-row"><a class="Link--primary" data-hovercard-type="pull_request" href="/acme/web/pull/11">Add dark mode</a></div>
       <div class="Box-row"><a class="Link--primary" data-hovercard-type="pull_request" href="/acme/web/pull/12">Refactor</a></div>
       <div class="Box-row"><a class="Link--primary" data-hovercard-type="pull_request" href="/acme/web/pull/99">Unrelated</a></div>
     </div></main>`,
  ),
};

async function main() {
  const { chromium } = loadPlaywright();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgl-e2e-"));
  const shotsDir = process.env.E2E_SCREENSHOTS;
  const executablePath = fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
    : undefined;

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    args: ["--headless=new", `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--no-sandbox"],
    viewport: { width: 1100, height: 520 },
  });

  const apiCalls = [];
  await context.route("https://claude.ai/**", async (route) => {
    const url = new URL(route.request().url());
    const headers = route.request().headers();
    if (url.pathname === "/v1/sessions") {
      apiCalls.push({ path: url.pathname, org: headers["x-organization-uuid"], beta: headers["anthropic-beta"] });
      return route.fulfill({ json: sessionsApi });
    }
    const ev = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (ev) {
      apiCalls.push({ path: url.pathname });
      return route.fulfill({ json: eventsApi[ev[1]] || { data: [] } });
    }
    return route.fulfill({
      contentType: "text/html",
      body: html(
        "Add dark mode - Claude Code",
        `<main><p>Opened <a href="https://github.com/acme/web/pull/11">acme/web#11</a></p></main>`,
      ),
    });
  });
  await context.route("https://github.com/**", async (route) => {
    const url = new URL(route.request().url());
    const body = githubPages[url.pathname];
    return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "not found" });
  });
  await context.addCookies([{ name: "lastActiveOrg", value: ORG, domain: "claude.ai", path: "/", secure: true }]);

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const getDb = () => worker.evaluate(async () => (await chrome.storage.local.get("db")).db);

  // 1. Visiting claude.ai triggers an API sync.
  const claude = await context.newPage();
  await claude.goto(`https://claude.ai/code/${SESSION_A}`);
  const deadline = Date.now() + 20000;
  let db;
  while (Date.now() < deadline) {
    db = await getDb();
    if (db && db.sessions[SESSION_B] && db.prs["acme/web#11"]) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(db && db.prs["acme/web#11"], "sync stored PR #11");
  assert.equal(db.prs["acme/web#11"].sessions[SESSION_A].kind, "created");
  assert.deepEqual(db.sessions[SESSION_B].branches, ["claude/branch-b"]);
  assert.equal(apiCalls.find((c) => c.path === "/v1/sessions").org, ORG);
  console.log("✓ sync stored sessions and relations");

  // 2. PR page shows a deep link to the session that created it.
  const gh = await context.newPage();
  await gh.goto("https://github.com/acme/web/pull/11");
  const chip = gh.locator(".gh-header-title .cgl-chip");
  await chip.waitFor({ timeout: 10000 });
  assert.equal(await chip.getAttribute("href"), `https://claude.ai/code/${SESSION_A}`);
  assert.match(await chip.innerText(), /Add dark mode/);
  if (shotsDir) await gh.screenshot({ path: path.join(shotsDir, "pr-page.png") });
  console.log("✓ PR page links to the creating session");

  // 3. Branch-only match (no URL anywhere, just the head branch).
  await gh.goto("https://github.com/acme/web/pull/13");
  await gh.locator(".cgl-chip").waitFor({ timeout: 10000 });
  assert.equal(await gh.locator(".cgl-chip").getAttribute("href"), `https://claude.ai/code/${SESSION_B}`);
  console.log("✓ PR matched by head branch");

  // 4. Backlink in PR body gets recorded and linked.
  await gh.goto("https://github.com/acme/web/pull/12");
  await gh.locator(".cgl-chip").waitFor({ timeout: 10000 });
  assert.equal(await gh.locator(".cgl-chip").getAttribute("href"), `https://claude.ai/code/${SESSION_C}`);
  db = await getDb();
  assert.equal(db.prs["acme/web#12"].sessions[SESSION_C].kind, "backlink");
  console.log("✓ backlink from PR body recorded");

  // 5. PR list annotates linked PRs only.
  await gh.goto("https://github.com/acme/web/pulls");
  await gh.locator(".cgl-inline").nth(1).waitFor({ timeout: 10000 });
  const inline = await gh.locator(".cgl-inline").evaluateAll((els) =>
    els.map((e) => [e.previousElementSibling.getAttribute("href"), e.getAttribute("href")]),
  );
  assert.deepEqual(inline, [
    ["/acme/web/pull/11", `https://claude.ai/code/${SESSION_A}`],
    ["/acme/web/pull/12", `https://claude.ai/code/${SESSION_C}`],
  ]);
  if (shotsDir) await gh.screenshot({ path: path.join(shotsDir, "pr-list.png") });
  console.log("✓ PR list links annotated");

  // 6. Popup lists the relations.
  const extId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 424, height: 560 });
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await popup.locator("#list li").first().waitFor();
  const count = await popup.locator("#list li").count();
  assert.ok(count >= 3, `popup lists relations (got ${count})`);
  if (shotsDir) await popup.screenshot({ path: path.join(shotsDir, "popup.png") });
  console.log("✓ popup lists relations");

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log("e2e passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
