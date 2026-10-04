# Claude Code ↔ GitHub PR Link

A Chrome extension (Manifest V3) that finds the Claude Code session behind each GitHub pull request and puts a
deep link on the PR. The link opens the session in the Claude app.

- **On a PR page:** an **Open in Claude · <session title>** chip next to the PR title. It opens
  `claude://resume?session=<id>&cwd=<project dir>`. Claude Code's own `/desktop` command uses the same link to move
  a session into Claude Desktop. If several sessions relate to the PR, a `+N` menu lists the others.
- **Anywhere a PR is linked on GitHub** (PR lists, notifications, references in comments): a small Claude icon after
  the link opens the session.
- **Popup:** status of the local scan and every stored PR ↔ session link, with search, settings, JSON export and
  "clear data". There is no sync button. The extension checks for changes every 30 seconds.

## How it works

```
~/.claude/projects/<project>/<session>.jsonl      Claude Code transcripts (local)
        │  read incrementally (only new bytes)
        ▼
host/claude-link-host.js     native messaging host, started by Chrome on demand
        │  stdio, one message per changed session
        ▼
src/background.js            polls every 30 s (chrome.alarms), stores relations
        │  chrome.storage.local
        ▼
src/content/github.js        adds the deep links on github.com
```

Chrome extensions cannot read files on disk. A small Node program, registered with Chrome as a
[native messaging host](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), reads
the transcripts. Chrome starts it for each check, and it exits when the check is done. For each transcript it
reports:

- the session's working directory, and the GitHub repo of that directory's `origin` remote;
- every git branch the session was on;
- its title (the summary or custom title, otherwise the first prompt);
- the GitHub PRs the session opened or mentioned.

Transcripts are append-only. After the first scan, each check reads only the bytes added since the last one.

When a PR has several related sessions, the strongest link comes first:

| Kind        | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `branch`    | The session worked on the PR's head branch in the same repo.                                  |
| `created`   | The session opened the PR (`gh pr create` / GitHub `create_pull_request` result, or said so).  |
| `backlink`  | The PR description links to a `https://claude.ai/code/session_…` cloud session.               |
| `mentioned` | The PR URL appears in the session (can be turned off in settings).                            |

PR URLs inside file contents the session read or wrote (Read/Write/Edit/Grep…) are ignored.

Cloud sessions (claude.ai/code) aren't on your disk. If a PR description links to one, the chip opens it on
claude.ai instead (**Claude Code (web)**).

All data stays on your machine, in `chrome.storage.local`. The extension makes no network requests.

## Install

Requirements: Chrome 120 or later (or Chromium, Brave, Edge, Arc), Node.js 18 or later, git, and the
[Claude desktop app](https://claude.ai/download) for the deep links.

1. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select
   this folder.
2. Register the helper. In this folder, run:
   ```
   npm run install-host
   ```
   This writes `com.claude_link.host.json` into each installed browser's `NativeMessagingHosts` folder (on
   Windows, it adds registry keys under `HKCU`). It also writes a launcher in `host/.bin/` that pins the path of
   the `node` you ran it with. If you use a custom `CLAUDE_CONFIG_DIR`, set it before you run the command.
3. Restart Chrome. Open the extension popup: the dot turns green and your sessions appear within a few seconds.

The first time you click a deep link, Chrome asks whether to open the Claude app. Tick **Always allow** to skip
this prompt next time.

The manifest has a fixed `key`, so the extension ID is always `fpbpannifdiekmippeaceoobhojaciep`. The helper only
accepts connections from that ID. If you move this folder or switch to a different `node`, run
`npm run install-host` again. To remove the helper: `npm run uninstall-host`.

## Development

```
npm test           # unit tests: core logic, transcript scanner, native host protocol
npm run test:e2e   # loads the extension + real native host in Chromium (Playwright) against fake github.com
npm run icons      # regenerate icons/*.png
```

```
manifest.json
host/
  claude-link-host.js    native messaging host (stdio protocol)
  scan.js                transcript discovery + incremental parsing
  install.js             registers the host with Chrome/Chromium/Brave/Edge/Arc
src/
  background.js          service worker: polling, storage, lookups
  shared/core.js         pure helpers: URL parsing, deep links, relation store, matching
  content/github.js      github.com: PR-page chip, inline link icons, backlink capture
  content/github.css
  popup/                 toolbar popup
test/                    unit tests
e2e/run.js               browser end-to-end test
```

## Caveats

- The transcript format isn't a documented API. The scanner relies only on `sessionId`, `cwd`, `gitBranch`,
  `timestamp`, `message.content` and summary lines. A future Claude Code release could still change these.
- GitHub's markup changes too. The PR-page code tries several selectors for the title and head branch. If it can't
  find the title, the chip floats in the bottom-right corner instead.
- The Chrome Web Store doesn't accept a `key` in the manifest. Remove it before you upload, then run
  `install-host` with the store-assigned ID in `allowed_origins`.
