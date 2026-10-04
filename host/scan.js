/*
 * Reads Claude Code session transcripts from disk
 * (`$CLAUDE_CONFIG_DIR/projects/<project>/<session-id>.jsonl`, default
 * `~/.claude`) and reduces each one to what the extension needs: cwd, repo,
 * git branches, title and the GitHub PRs the session created or mentioned.
 *
 * Transcripts are append-only, so a rescan reads only the bytes added since
 * the previous scan.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");
const { classifyEventPrRefs, extractPrRefs, strongerKind, normalizeRepo } = require("../src/shared/core.js");

const MAX_PRS_PER_SESSION = 200;
// Context injected into the transcript rather than produced by the session.
const SKIPPED_TYPES = new Set(["attachment", "queue-operation", "file-history-snapshot"]);
// File contents the session read or wrote are not things it did on GitHub.
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob"]);

function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function projectsDir(env = process.env) {
  return path.join(claudeConfigDir(env), "projects");
}

/** Every top-level `<session>.jsonl` under the projects dir. */
function listSessionFiles(root) {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(root, p.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith(".jsonl")) out.push(path.join(dir, f.name));
    }
  }
  return out;
}

const repoCache = new Map();
/** `owner/repo` of the cwd's `origin` remote, if it is a GitHub repo. */
function repoForCwd(cwd) {
  if (!cwd) return null;
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let repo = null;
  try {
    if (fs.existsSync(cwd)) {
      const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      repo = normalizeRepo(url.trim());
    }
  } catch (_) {
    // not a git repo / no origin / git missing
  }
  repoCache.set(cwd, repo);
  return repo;
}

function contentBlocks(entry) {
  const c = entry && entry.message && entry.message.content;
  return Array.isArray(c) ? c.filter((b) => b && typeof b === "object") : [];
}

function isCreatePrCall(block) {
  if (/create_pull_request/i.test(block.name || "")) return true;
  return /\bgh\s+pr\s+create\b/.test(JSON.stringify(block.input || ""));
}

function mentions(text) {
  return extractPrRefs(text).map((r) => ({ ...r, kind: "mentioned" }));
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
    session: { id, cwd: null, title: null, firstPrompt: null, branches: [], repos: [], updatedAt: null, source: "local" },
    prs: [],
    end: start,
  };
  const branches = new Set();
  const prs = new Map();
  const createCalls = new Set();
  const toolNames = new Map();
  let customTitle = null;
  let summary = null;

  const addRefs = (refs) => {
    for (const ref of refs) {
      const prev = prs.get(ref.key);
      prs.set(ref.key, prev ? { ...ref, kind: strongerKind(prev.kind, ref.kind) } : ref);
    }
  };

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
    if (entry.gitBranch && entry.gitBranch !== "HEAD") branches.add(entry.gitBranch);
    if (entry.timestamp && (!result.session.updatedAt || entry.timestamp > result.session.updatedAt)) {
      result.session.updatedAt = entry.timestamp;
    }
    if (entry.customTitle) customTitle = String(entry.customTitle);
    if (entry.aiTitle) summary = String(entry.aiTitle);
    if (entry.type === "summary" && entry.summary) summary = String(entry.summary);
    // Only a scan from the top of the file knows which prompt came first.
    if (start === 0 && !result.session.firstPrompt) result.session.firstPrompt = promptText(entry);

    if (SKIPPED_TYPES.has(entry.type)) continue;
    if (!(line.includes("github.com") && line.includes("/pull/")) && !line.includes('"tool_use"')) continue;
    const content = entry.message && entry.message.content;
    if (typeof content === "string") addRefs(mentions(content));
    for (const block of contentBlocks(entry)) {
      if (block.type === "text") {
        addRefs(classifyEventPrRefs(block.text || ""));
      } else if (block.type === "tool_use" && block.id) {
        toolNames.set(block.id, block.name || "");
        if (isCreatePrCall(block)) createCalls.add(block.id);
        if (!FILE_TOOLS.has(block.name)) addRefs(mentions(JSON.stringify(block.input || "")));
      } else if (block.type === "tool_result") {
        const text = JSON.stringify(block.content || "");
        if (createCalls.has(block.tool_use_id)) addRefs(extractPrRefs(text).map((r) => ({ ...r, kind: "created" })));
        else if (!FILE_TOOLS.has(toolNames.get(block.tool_use_id))) addRefs(mentions(text));
      }
    }
  }
  rl.close();
  stream.destroy();

  // Re-read an unparseable last line next time; it is probably half-written.
  // (The last line may also lack its newline, hence the clamp to the file size.)
  const size = fs.statSync(file).size;
  result.end = badLineStart >= 0 ? badLineStart : Math.min(consumed, size);

  result.session.title = customTitle || summary;
  result.session.branches = [...branches];
  const repo = repoForCwd(result.session.cwd);
  if (repo) result.session.repos = [repo];
  result.prs = [...prs.values()].slice(0, MAX_PRS_PER_SESSION).map(({ owner, repo: r, number, kind }) => ({ owner, repo: r, number, kind }));
  return result;
}

/**
 * Scan every transcript that changed since `known` ({ [file]: {size, mtimeMs} }).
 * Calls `onSession(file, stat, parsed)` for each changed file.
 */
async function scanProjects(root, known = {}, onSession = () => {}) {
  const files = listSessionFiles(root);
  let changed = 0;
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      continue;
    }
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

module.exports = { claudeConfigDir, projectsDir, listSessionFiles, parseSessionFile, scanProjects, repoForCwd };
