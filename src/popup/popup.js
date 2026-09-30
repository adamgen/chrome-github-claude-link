(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = { branch: "branch", created: "opened", backlink: "backlink", mentioned: "mentioned" };
  const SETTING_IDS = ["autoSync", "syncIntervalMinutes", "matchBranch", "showMentioned"];

  let relations = [];

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
  }

  function ago(ts) {
    if (!ts) return "never";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
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
    if (r && !r.ok) {
      const hint = r.status === 401 || r.status === 403 ? " — are you signed in to claude.ai?" : "";
      setStatus(`${counts} · last sync failed: ${r.error}${hint}`, true);
    } else {
      setStatus(`${counts} · synced ${ago(o.lastSyncAt)}`);
    }
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
    const list = $("list");
    list.replaceChildren(
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
        session.target = "_blank";
        session.textContent = r.sessionTitle || r.sessionId;
        li.append(kind, pr, session);
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
      if (el.type === "checkbox") el.checked = !!o.settings[id];
      else el.value = o.settings[id];
    }
  }

  $("filter").addEventListener("input", renderList);

  $("sync").addEventListener("click", async () => {
    $("sync").disabled = true;
    setStatus("Syncing…");
    const res = await send({ type: "cgl:sync-now" });
    if (!res.ok) {
      $("sync").disabled = false;
      setStatus(`Could not start sync: ${res.error || res.reason}`, true);
    } else if (res.via === "new-tab") {
      setStatus("Opened claude.ai in a background tab to sync…");
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "cgl:progress") return;
    if (msg.done) {
      $("sync").disabled = false;
      load();
    } else if (msg.total) {
      setStatus(`Scanning sessions… ${msg.done}/${msg.total}`);
    }
  });

  for (const id of SETTING_IDS) {
    $(id).addEventListener("change", (e) => {
      const el = e.target;
      let value = el.type === "checkbox" ? el.checked : Number(el.value);
      if (id === "syncIntervalMinutes") value = Math.min(1440, Math.max(5, value || 15));
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
    if (!confirm("Delete all stored session ↔ PR links?")) return;
    await send({ type: "cgl:clear" });
    load();
  });

  load();
})();
