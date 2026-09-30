/*
 * Runs on github.com. On a pull request page it adds a link to the Claude
 * Code session(s) behind the PR next to the title; everywhere else it adds a
 * small Claude icon after pull request links that have a known session.
 *
 * It also records "backlinks": claude.ai/code/session_… URLs that appear in a
 * PR's description or commits (Claude Code adds these by default).
 */
(() => {
  "use strict";
  const { parsePrUrl, prKey, extractSessionLinks } = globalThis.CGL;

  const KIND_LABEL = {
    branch: "pushed to this PR's branch",
    created: "opened this PR",
    backlink: "linked from this PR",
    mentioned: "mentions this PR",
  };

  const ICON_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M8 0l1.6 5.1L15 3.6l-3.9 4L15 12.4l-5.4-1.5L8 16l-1.6-5.1L1 12.4l3.9-4.8L1 3.6l5.4 1.5z"/></svg>';

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res || { ok: false });
        });
      } catch (_) {
        resolve({ ok: false });
      }
    });
  }

  // ---- lookups (cached per page; cleared whenever the store changes) -------

  let cache = new Map(); // prKey → sessions[] | Promise
  let generation = 0;

  async function lookupMany(prs) {
    const missing = prs.filter((p) => !cache.has(prKey(p.owner, p.repo, p.number)) || p.headBranch);
    if (missing.length) {
      const gen = generation;
      const pending = send({ type: "cgl:lookup", prs: missing });
      for (const p of missing) cache.set(prKey(p.owner, p.repo, p.number), pending.then((r) => (r.results || {})[prKey(p.owner, p.repo, p.number)] || []));
      const res = await pending;
      if (gen === generation) {
        for (const [k, v] of Object.entries(res.results || {})) cache.set(k, v);
      }
    }
    const out = {};
    for (const p of prs) {
      const k = prKey(p.owner, p.repo, p.number);
      out[k] = (await cache.get(k)) || [];
    }
    return out;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.db || changes.settings)) {
      cache = new Map();
      generation++;
      document.querySelectorAll("[data-cgl-done]").forEach((a) => a.removeAttribute("data-cgl-done"));
      schedule(0);
    }
  });

  // ---- pull request page -------------------------------------------------

  function currentPr() {
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(location.pathname);
    return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
  }

  function cleanBranch(text) {
    if (!text) return null;
    let b = String(text).trim().split(/\s+/)[0];
    // "owner:branch" / "owner/repo:branch" for cross-repo PRs.
    const colon = b.lastIndexOf(":");
    if (colon >= 0) b = b.slice(colon + 1);
    return b || null;
  }

  function headBranch() {
    const selectors = [
      ".gh-header-meta .head-ref",
      ".commit-ref.head-ref",
      "span.head-ref",
      '[data-testid="head-ref"]',
      '[class*="PullRequestHeaderSummary"] [class*="BranchName"]:last-of-type',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const b = cleanBranch(el.getAttribute("title") || el.textContent);
      if (b) return b;
    }
    // Fallback: "… wants to merge 3 commits into main from claude/foo"
    const header = document.querySelector("#partial-discussion-header, main header, main") || document.body;
    const m = /\binto\s+(\S+)\s+from\s+(\S+)/.exec((header.innerText || "").slice(0, 4000));
    return m ? cleanBranch(m[2]) : null;
  }

  function collectBacklinks(pr) {
    const scope = document.querySelector(".js-discussion, .pull-discussion-timeline, main") || document.body;
    const hrefs = [...scope.querySelectorAll('a[href*="claude.ai/code/session_"]')].map((a) => a.href);
    const ids = extractSessionLinks(hrefs.join("\n") + "\n" + (scope.innerText || ""));
    if (!ids.length) return Promise.resolve();
    return send({
      type: "cgl:record",
      relations: ids.map((sessionId) => ({ sessionId, ref: { ...pr, kind: "backlink" }, source: "github-page" })),
    });
  }

  function titleAnchor() {
    const candidates = [
      ".gh-header-show h1.gh-header-title",
      "#partial-discussion-header h1",
      '[data-component="PH_Title"]',
      '[class*="PullRequestHeader"] h1',
      '[data-testid="issue-title"]',
      "main h1",
    ];
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest(".gh-header-sticky, .sticky-content, [class*='Sticky']")) continue;
        if (el.offsetParent !== null || el.getClientRects().length) return el;
      }
    }
    return null;
  }

  function sessionLabel(s) {
    return s.title || s.id.replace(/^session_/, "session ").slice(0, 20) + "…";
  }

  function buildHeaderWidget(sessions) {
    const wrap = document.createElement("span");
    wrap.className = "cgl-header";
    wrap.dataset.cglHeader = "1";

    const [first, ...rest] = sessions;
    const main = document.createElement("a");
    main.className = "cgl-chip";
    main.href = first.url;
    main.target = "_blank";
    main.rel = "noopener";
    main.title = `Open the Claude Code session that ${KIND_LABEL[first.kind] || "relates to this PR"}\n${first.title || first.id}`;
    main.innerHTML = ICON_SVG;
    const label = document.createElement("span");
    label.className = "cgl-chip-label";
    label.textContent = "Claude Code";
    const sub = document.createElement("span");
    sub.className = "cgl-chip-sub";
    sub.textContent = sessionLabel(first);
    main.append(label, sub);
    wrap.append(main);

    if (rest.length) {
      const more = document.createElement("details");
      more.className = "cgl-more";
      const summary = document.createElement("summary");
      summary.textContent = `+${rest.length}`;
      summary.title = `${rest.length} more related Claude Code session${rest.length > 1 ? "s" : ""}`;
      const list = document.createElement("div");
      list.className = "cgl-menu";
      for (const s of rest) {
        const a = document.createElement("a");
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "cgl-menu-item";
        const t = document.createElement("span");
        t.textContent = sessionLabel(s);
        const k = document.createElement("small");
        k.textContent = KIND_LABEL[s.kind] || s.kind;
        a.append(t, k);
        list.append(a);
      }
      more.append(summary, list);
      wrap.append(more);
    }
    return wrap;
  }

  let headerState = { key: null, sig: null };

  async function renderPrPage() {
    const pr = currentPr();
    const existing = document.querySelectorAll("[data-cgl-header]");
    if (!pr) {
      existing.forEach((e) => e.remove());
      headerState = { key: null, sig: null };
      return;
    }
    const key = prKey(pr.owner, pr.repo, pr.number);
    if (headerState.key !== key) {
      headerState = { key, sig: null };
      await collectBacklinks(pr);
    }
    const branch = headBranch();
    const results = await lookupMany([{ ...pr, headBranch: branch }]);
    const now = currentPr();
    if (!now || prKey(now.owner, now.repo, now.number) !== key) return; // navigated away meanwhile
    const sessions = results[key] || [];
    const sig = sessions.map((s) => `${s.id}:${s.kind}:${s.title}`).join("|");
    const stillMounted = [...existing].some((e) => e.isConnected);
    if (sig === headerState.sig && (stillMounted || !sessions.length)) return;
    existing.forEach((e) => e.remove());
    headerState.sig = sig;
    if (!sessions.length) return;

    const widget = buildHeaderWidget(sessions);
    const anchor = titleAnchor();
    if (anchor) {
      anchor.append(widget);
    } else {
      widget.classList.add("cgl-floating");
      document.body.append(widget);
    }
  }

  // ---- PR links anywhere on GitHub --------------------------------------

  const LINK_SELECTOR = 'a[href*="/pull/"]';

  function eligibleAnchor(a, current) {
    if (a.dataset.cglDone || a.closest("[data-cgl-header], .cgl-inline")) return null;
    if (a.closest("nav, [role='tablist'], .tabnav-tabs, .UnderlineNav, .gh-header, .js-sticky, .AvatarStack")) return null;
    if (!a.textContent.trim()) return null;
    const pr = parsePrUrl(a.getAttribute("href"), { allowSubpath: false });
    if (!pr) return null;
    if (current && prKey(pr.owner, pr.repo, pr.number) === prKey(current.owner, current.repo, current.number)) return null;
    return pr;
  }

  async function annotateLinks() {
    const current = currentPr();
    const targets = [];
    for (const a of document.querySelectorAll(LINK_SELECTOR)) {
      const pr = eligibleAnchor(a, current);
      if (!pr) continue;
      a.dataset.cglDone = "1";
      targets.push({ a, pr });
    }
    if (!targets.length) return;
    const unique = new Map(targets.map((t) => [prKey(t.pr.owner, t.pr.repo, t.pr.number), t.pr]));
    const results = await lookupMany([...unique.values()]);
    for (const { a, pr } of targets) {
      const sessions = results[prKey(pr.owner, pr.repo, pr.number)] || [];
      const next = a.nextElementSibling;
      if (next && next.classList.contains("cgl-inline")) next.remove();
      if (!sessions.length || !a.isConnected) continue;
      const s = sessions[0];
      const link = document.createElement("a");
      link.className = "cgl-inline";
      link.href = s.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.title = `Claude Code session: ${s.title || s.id}${sessions.length > 1 ? ` (+${sessions.length - 1} more)` : ""}`;
      link.setAttribute("aria-label", link.title);
      link.innerHTML = ICON_SVG;
      a.after(link);
    }
  }

  // ---- scheduling ---------------------------------------------------------

  let timer = null;
  let running = false;
  let again = false;

  async function refresh() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await renderPrPage();
      await annotateLinks();
    } catch (e) {
      console.debug("[claude-link]", e);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }

  function schedule(delay = 400) {
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  }

  new MutationObserver((records) => {
    // Ignore mutations caused by our own injected nodes.
    const ours = records.every((r) =>
      [...r.addedNodes, ...r.removedNodes].every((n) => n.nodeType === 1 && n.matches && n.matches("[data-cgl-header], .cgl-inline")),
    );
    if (!ours) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("turbo:load", () => schedule(0));
  window.addEventListener("popstate", () => schedule(0));
  schedule(0);
})();
