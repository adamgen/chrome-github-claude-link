#!/usr/bin/env node
/*
 * Chrome native messaging host for the Claude Code ↔ GitHub PR Link
 * extension. Chrome starts it on demand; it reads local Claude Code
 * transcripts and streams one message per changed session back.
 *
 * Protocol (both directions): 4-byte little-endian length + UTF-8 JSON.
 *   → { type: "ping" }                      ← { type: "pong", version, projectsDir }
 *   → { type: "scan", known: {file: {size, mtimeMs}} }
 *                                           ← { type: "session", file, stat, session, prs, full }  (×N)
 *                                           ← { type: "done", files, changed, ms }
 *   any failure                             ← { type: "error", error }
 */
"use strict";

const { projectsDir, scanProjects } = require("./scan.js");
const { version } = require("../package.json");

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return new Promise((resolve) => {
    if (process.stdout.write(Buffer.concat([header, body]))) resolve();
    else process.stdout.once("drain", resolve);
  });
}

async function handle(msg) {
  const root = projectsDir();
  if (msg.type === "ping") return send({ type: "pong", version, projectsDir: root });
  if (msg.type === "scan") {
    const started = Date.now();
    const res = await scanProjects(root, msg.known || {}, (file, stat, parsed, start) =>
      send({ type: "session", file, stat, session: parsed.session, prs: parsed.prs, full: start === 0 }),
    );
    return send({ type: "done", ...res, projectsDir: root, ms: Date.now() - started });
  }
  return send({ type: "error", error: `unknown message type: ${msg.type}` });
}

let buf = Buffer.alloc(0);
let queue = Promise.resolve();

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString("utf8");
    buf = buf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      queue = queue.then(() => send({ type: "error", error: `bad message: ${e.message}` }));
      continue;
    }
    queue = queue.then(() => handle(msg)).catch((e) => send({ type: "error", error: String((e && e.message) || e) }));
  }
});

// Chrome closes stdin when the extension disconnects.
process.stdin.on("end", () => queue.finally(() => process.exit(0)));
