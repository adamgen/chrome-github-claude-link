#!/usr/bin/env node
/*
 * Prints the Claude app deep link for a local Claude Code session, so you can
 * check that clicking it opens the session in Claude Desktop.
 *
 *   npm run demo-link                 most recently active local session
 *   npm run demo-link -- <session-id> a specific session
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { projectsDir, listSessionFiles, parseSessionFile } = require("../host/scan.js");
const { desktopResumeUrl, sessionTitle } = require("../src/shared/core.js");

async function main() {
  const wanted = process.argv[2];
  const files = listSessionFiles(projectsDir());
  const file = wanted
    ? files.find((f) => path.basename(f, ".jsonl") === wanted)
    : files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!file) {
    console.error(wanted ? `No local session ${wanted} in ${projectsDir()}` : `No sessions in ${projectsDir()}`);
    process.exit(1);
  }
  const { session } = await parseSessionFile(file);
  console.log(`Session: ${sessionTitle(session) || "(untitled)"}`);
  console.log(`Folder:  ${session.cwd}`);
  console.log(`Branch:  ${session.branches.join(", ") || "-"}`);
  console.log(`\n${desktopResumeUrl(session.id, session.cwd)}\n`);
  console.log("Paste the link into the Chrome address bar and press Enter.");
}

main();
