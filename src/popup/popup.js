(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = { branch: "branch", created: "opened", backlink: "backlink", mentioned: "mentioned" };
  const SETTING_IDS = ["pollSeconds", "matchBranch", "showMentioned"];

  let relations = [];

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
  }

  function ago(ts) {
    if (!ts) return "never";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function setStatus(text, isError = false) {
    $("status").textContent = text;
    $("status").classList.toggle("error", isError);
  }

  function renderStatus(o) {
    const r = o.lastResult;
    const counts = `${o.prCount} PR${o.prCount === 1 ? "" : "s"} · ${o.sessionCount} session${o.sessionCount === 1 ? "" : "s"}`;
    $("live").className = `live ${o.polling ? "busy" : r && !r.ok ? "error" : r ? "ok" : ""}`;
    $("setup").hidden = !(r && !r.ok && r.hostMissing);
    $("setupError").textContent = r && r.hostMissing ? `Chrome said: ${r.error}` : "";
    if (o.polling && !o.lastScanAt) setStatus(`${counts} · reading local sessions…`);
    else if (r && !r.ok) setStatus(`${counts} · ${r.hostMissing ? "helper not installed" : `scan failed: ${r.error}`}`, true);
    else setStatus(`${counts} · checked ${ago(o.lastScanAt)}${r && r.projectsDir ? ` · ${r.projectsDir}` : ""}`);
  }

  function renderList() {
    const q = $("filter").value.trim().toLowerCase();
    const rows = relations.filter(
      (r) =>
        !q ||
        `${r.owner}/${r.repo}#${r.number}`.toLowerCase().includes(q) ||
        (r.sessionTitle || "").toLowerCase().includes(q) ||
        r.sessionId.toLowerCase().includes(q),
    );
    $("list").replaceChildren(
      ...rows.slice(0, 200).map((r) => {
        const li = document.createElement("li");
        const kind = document.createElement("span");
        kind.className = "kind";
        kind.textContent = KIND_LABEL[r.kind] || r.kind;
        kind.title = `Sources: ${r.sources.join(", ")}`;
        const pr = document.createElement("a");
        pr.className = "pr";
        pr.href = r.prUrl;
        pr.target = "_blank";
        pr.textContent = `${r.owner}/${r.repo}#${r.number}`;
        const session = document.createElement("a");
        session.className = "session";
        session.href = r.sessionUrl;
        session.textContent = r.sessionTitle || r.sessionId;
        session.title = r.app ? "Open in the Claude app" : "Open on claude.ai";
        if (r.app) {
          // Popups cannot navigate to external protocols themselves.
          session.addEventListener("click", (e) => {
            e.preventDefault();
            chrome.tabs.update({ url: r.sessionUrl });
          });
        } else {
          session.target = "_blank";
        }
        const where = document.createElement("span");
        where.className = "app";
        where.textContent = r.app ? "app" : "web";
        li.append(kind, pr, where, session);
        return li;
      }),
    );
    $("empty").hidden = relations.length > 0;
  }

  async function load() {
    const o = await send({ type: "cgl:overview" });
    if (!o || !o.ok) return setStatus(`Error: ${(o && o.error) || "no response"}`, true);
    relations = o.relations;
    renderStatus(o);
    renderList();
    for (const id of SETTING_IDS) {
      const el = $(id);
      if (document.activeElement === el) continue;
      if (el.type === "checkbox") el.checked = !!o.settings[id];
      else el.value = o.settings[id];
    }
  }

  $("filter").addEventListener("input", renderList);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "cgl:scanned") load();
  });

  for (const id of SETTING_IDS) {
    $(id).addEventListener("change", (e) => {
      const el = e.target;
      let value = el.type === "checkbox" ? el.checked : Number(el.value);
      if (id === "pollSeconds") value = Math.min(3600, Math.max(30, value || 30));
      send({ type: "cgl:settings", settings: { [id]: value } });
    });
  }

  $("export").addEventListener("click", async () => {
    const { db } = await send({ type: "cgl:export" });
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `claude-pr-links-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $("clear").addEventListener("click", async () => {
    if (!confirm("Delete all stored session ↔ PR links? They are rebuilt from your local sessions.")) return;
    await send({ type: "cgl:clear" });
    load();
  });

  // Opening the popup also checks for changes right away.
  load().then(() => send({ type: "cgl:poll" }));
  setInterval(load, 5000);
})();
