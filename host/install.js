#!/usr/bin/env node
/*
 * Registers the native messaging host with Chrome (and Chromium, Brave, Edge,
 * Arc when present) for the current user.
 *
 *   node host/install.js              install
 *   node host/install.js --uninstall  remove
 *   node host/install.js --target-dir <dir>   write the host manifest only there
 *   node host/install.js --bin-dir <dir>      put the launcher script there (default host/.bin)
 *
 * The extension ID is derived from the "key" in manifest.json, so it is the
 * same on every machine that loads this folder unpacked.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const HOST_NAME = "com.claude_link.host";
const ROOT = path.resolve(__dirname, "..");
let BIN_DIR = path.join(__dirname, ".bin");

function extensionId() {
  const { key } = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const hex = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** Per-user NativeMessagingHosts dirs (macOS / Linux) for installed browsers. */
function manifestDirs() {
  const home = os.homedir();
  const browsers =
    process.platform === "darwin"
      ? [
          ["Google Chrome", "Library/Application Support/Google/Chrome"],
          ["Chrome Beta", "Library/Application Support/Google/Chrome Beta"],
          ["Chrome Canary", "Library/Application Support/Google/Chrome Canary"],
          ["Chromium", "Library/Application Support/Chromium"],
          ["Brave", "Library/Application Support/BraveSoftware/Brave-Browser"],
          ["Edge", "Library/Application Support/Microsoft Edge"],
          ["Arc", "Library/Application Support/Arc/User Data"],
        ]
      : [
          ["Google Chrome", ".config/google-chrome"],
          ["Chrome Beta", ".config/google-chrome-beta"],
          ["Chromium", ".config/chromium"],
          ["Brave", ".config/BraveSoftware/Brave-Browser"],
          ["Edge", ".config/microsoft-edge"],
        ];
  return browsers
    .map(([name, rel]) => ({ name, profile: path.join(home, rel) }))
    .filter((b, i) => i === 0 || fs.existsSync(b.profile))
    .map((b) => ({ name: b.name, dir: path.join(b.profile, "NativeMessagingHosts") }));
}

const WINDOWS_REG_KEYS = [
  ["Google Chrome", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts"],
  ["Chromium", "HKCU\\Software\\Chromium\\NativeMessagingHosts"],
  ["Brave", "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts"],
  ["Edge", "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts"],
];

/**
 * Chrome starts the host without your shell's PATH (nvm, Homebrew …), so the
 * launcher pins the absolute path of the node that ran this installer.
 */
function writeLauncher() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const script = path.join(__dirname, "claude-link-host.js");
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (process.platform === "win32") {
    const file = path.join(BIN_DIR, "claude-link-host.bat");
    const env = configDir ? `set "CLAUDE_CONFIG_DIR=${configDir}"\r\n` : "";
    fs.writeFileSync(file, `@echo off\r\n${env}"${process.execPath}" "${script}" %*\r\n`);
    return file;
  }
  const file = path.join(BIN_DIR, "claude-link-host");
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const env = configDir ? `export CLAUDE_CONFIG_DIR=${q(configDir)}\n` : "";
  fs.writeFileSync(file, `#!/bin/sh\n${env}exec ${q(process.execPath)} ${q(script)} "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function hostManifest(launcher, id) {
  return {
    name: HOST_NAME,
    description: "Reads local Claude Code sessions for the Claude Code ↔ GitHub PR Link extension",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  };
}

function main(argv) {
  const uninstall = argv.includes("--uninstall");
  const t = argv.indexOf("--target-dir");
  const targetDir = t >= 0 ? path.resolve(argv[t + 1]) : null;
  const b = argv.indexOf("--bin-dir");
  if (b >= 0) BIN_DIR = path.resolve(argv[b + 1]);
  const id = extensionId();
  const file = `${HOST_NAME}.json`;

  if (process.platform === "win32" && !targetDir) {
    const manifestPath = path.join(BIN_DIR, file);
    for (const [name, key] of WINDOWS_REG_KEYS) {
      const regKey = `${key}\\${HOST_NAME}`;
      try {
        if (uninstall) execFileSync("reg", ["delete", regKey, "/f"], { stdio: "ignore" });
        else execFileSync("reg", ["add", regKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "ignore" });
        console.log(`${uninstall ? "removed" : "registered"}: ${name}`);
      } catch (_) {
        // browser not installed / key missing
      }
    }
    if (uninstall) fs.rmSync(BIN_DIR, { recursive: true, force: true });
    else fs.writeFileSync(manifestPath, JSON.stringify(hostManifest(writeLauncher(), id), null, 2));
    return;
  }

  const dirs = targetDir ? [{ name: "target", dir: targetDir }] : manifestDirs();
  const launcher = uninstall ? null : writeLauncher();
  for (const { name, dir } of dirs) {
    const dest = path.join(dir, file);
    if (uninstall) {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest);
        console.log(`removed: ${name} (${dest})`);
      }
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(hostManifest(launcher, id), null, 2));
    console.log(`installed: ${name} (${dest})`);
  }
  if (uninstall) fs.rmSync(BIN_DIR, { recursive: true, force: true });
  else console.log(`extension id: ${id}\nlauncher: ${launcher}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { extensionId, HOST_NAME };
