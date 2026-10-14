/*
 * Reads the PR links Claude Code and the Claude app already record, and the
 * session details the extension shows next to them:
 *
 * - transcripts (`$CLAUDE_CONFIG_DIR/projects/<project>/<session-id>.jsonl`,
 *   default `~/.claude`): cwd, title, first prompt, and the PRs in the
 *   `{"type":"pr-link", prUrl, …}` entries Claude Code writes;
 * - Claude app session files (`<app data>/Claude/claude-code-sessions/…/*.json`):
 *   the app's title and the PRs in `prs[]`, keyed by `cliSessionId`.
 *
 * Transcripts are append-only, so a rescan reads only the bytes added since
 * the previous scan. App session files are small and rewritten in place, so a
 * changed one is read whole.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { parsePrUrl } = require("../src/shared/core.js");

const MAX_PRS_PER_SESSION = 200;

function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function projectsDir(env = process.env) {
  return path.join(claudeConfigDir(env), "projects");
}

/** Where the Claude desktop app keeps its Claude Code session metadata. */
function appSessionsDir(env = process.env, platform = process.platform) {
  if (env.CLAUDE_APP_SESSIONS_DIR) return env.CLAUDE_APP_SESSIONS_DIR;
  const home = os.homedir();
  const appData =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || path.join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(appData, "Claude", "claude-code-sessions");
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

/** Every top-level `<session>.jsonl` under the projects dir. */
function listSessionFiles(root) {
  const out = [];
  for (const p of readDir(root)) {
    if (!p.isDirectory()) continue;
    const dir = path.join(root, p.name);
    for (const f of readDir(dir)) {
      if (f.isFile() && f.name.endsWith(".jsonl")) out.push(path.join(dir, f.name));
    }
  }
  return out;
}

/** Every `*.json` under the app sessions dir (`<account>/<org>/local_<id>.json`). */
function listAppSessionFiles(root, depth = 3) {
  const out = [];
  for (const e of readDir(root)) {
    const p = path.join(root, e.name);
    if (e.isDirectory() && depth > 0) out.push(...listAppSessionFiles(p, depth - 1));
    else if (e.isFile() && e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

/** `{ owner, repo, number, kind: "linked" }` for a PR URL, else null. */
function linkedPr(url) {
  const pr = parsePrUrl(url, { allowSubpath: false });
  return pr ? { ...pr, kind: "linked" } : null;
}

function uniquePrs(prs) {
  const out = new Map();
  for (const pr of prs) {
    if (pr) out.set(`${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase(), pr);
  }
  return [...out.values()].slice(0, MAX_PRS_PER_SESSION);
}

function promptText(entry) {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  const c = entry.message && entry.message.content;
  let text = typeof c === "string" ? c : null;
  if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === "tool_result")) return null;
    const t = c.find((b) => b && b.type === "text");
    text = t ? t.text : null;
  }
  if (!text) return null;
  text = text.trim();
  // Slash commands, caveats and hook output are wrapped in <tags>.
  if (!text || text.startsWith("<")) return null;
  return text.replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Parse one transcript starting at byte `start`. Only complete lines are
 * consumed; `end` is the offset to resume from next time.
 */
async function parseSessionFile(file, start = 0) {
  const id = path.basename(file, ".jsonl");
  const result = {
    session: { id, cwd: null, title: null, firstPrompt: null, updatedAt: null, source: "local" },
    prs: [],
    end: start,
  };
  const prs = [];
  let customTitle = null;
  let summary = null;

  const stream = fs.createReadStream(file, { start, encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  // readline drops the newline, so count bytes to know where each line starts.
  let consumed = start;
  let badLineStart = -1; // start of the last line, if it failed to parse
  for await (const line of rl) {
    const lineStart = consumed;
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
      badLineStart = -1;
    } catch (_) {
      // Corrupt, or (if it is the last line) still being written.
      badLineStart = lineStart;
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    if (entry.cwd) result.session.cwd = entry.cwd;
    if (entry.timestamp && (!result.session.updatedAt || entry.timestamp > result.session.updatedAt)) {
      result.session.updatedAt = entry.timestamp;
    }
    if (entry.customTitle) customTitle = String(entry.customTitle);
    if (entry.aiTitle) summary = String(entry.aiTitle);
    if (entry.type === "summary" && entry.summary) summary = String(entry.summary);
    if (entry.type === "pr-link") prs.push(linkedPr(entry.prUrl));
    // Only a scan from the top of the file knows which prompt came first.
    if (start === 0 && !result.session.firstPrompt) result.session.firstPrompt = promptText(entry);
  }
  rl.close();
  stream.destroy();

  // Re-read an unparseable last line next time; it is probably half-written.
  // (The last line may also lack its newline, hence the clamp to the file size.)
  const size = fs.statSync(file).size;
  result.end = badLineStart >= 0 ? badLineStart : Math.min(consumed, size);

  result.session.title = customTitle || summary;
  result.prs = uniquePrs(prs);
  return result;
}

/**
 * Parse one Claude app session file. Returns null when it is not tied to a
 * local Claude Code session (no `cliSessionId`) or is unreadable.
 */
function parseAppSessionFile(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== "object" || !data.cliSessionId) return null;
  const urls = [...(Array.isArray(data.prs) ? data.prs.map((p) => p && p.url) : []), data.prUrl];
  return {
    // `appTitle`: the title the Claude app shows, which the user may have renamed.
    session: { id: String(data.cliSessionId), cwd: data.cwd || null, appTitle: data.title || null },
    prs: uniquePrs(urls.map(linkedPr)),
  };
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch (_) {
    return null;
  }
}

/**
 * Scan every transcript that changed since `known` ({ [file]: {size, mtimeMs} }).
 * Calls `onSession(file, stat, parsed, start)` for each changed file.
 */
async function scanProjects(root, known = {}, onSession = () => {}) {
  const files = listSessionFiles(root);
  let changed = 0;
  for (const file of files) {
    const stat = statOrNull(file);
    if (!stat) continue;
    const prev = known[file];
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) continue;
    const start = prev && stat.size > prev.size ? prev.size : 0;
    let parsed;
    try {
      parsed = await parseSessionFile(file, start);
    } catch (_) {
      continue;
    }
    changed++;
    await onSession(file, { size: parsed.end, mtimeMs: stat.mtimeMs }, parsed, start);
  }
  return { files: files.length, changed };
}

/** Like scanProjects, for the Claude app's session files. */
async function scanAppSessions(root, known = {}, onSession = () => {}) {
  const files = listAppSessionFiles(root);
  let changed = 0;
  for (const file of files) {
    const stat = statOrNull(file);
    if (!stat) continue;
    const prev = known[file];
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) continue;
    const parsed = parseAppSessionFile(file);
    if (parsed) changed++;
    // Remember files without a CLI session too, so they are not re-read every time.
    await onSession(file, { size: stat.size, mtimeMs: stat.mtimeMs }, parsed, 0);
  }
  return { files: files.length, changed };
}

module.exports = {
  claudeConfigDir,
  projectsDir,
  appSessionsDir,
  listSessionFiles,
  listAppSessionFiles,
  parseSessionFile,
  parseAppSessionFile,
  scanProjects,
  scanAppSessions,
};
