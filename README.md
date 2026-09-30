# Claude Code ↔ GitHub PR Link

A Chrome extension (Manifest V3) that remembers which [Claude Code](https://claude.ai/code) session produced
each GitHub pull request, and adds a deep link back to that session on GitHub.

- **On a PR page:** a **Claude Code · <session title>** chip next to the PR title opens the conversation. If several
  sessions relate to the PR, a `+N` menu lists the others.
- **Anywhere a PR is linked on GitHub** (PR lists, notifications, references in comments): a small Claude icon after
  the link opens the session.
- **Popup:** lists every stored PR ↔ session link, with search, **Sync now**, settings, JSON export and "clear data".

## How relations are found

The extension collects links from four sources. When a PR has several, the strongest comes first:

| Kind        | Source                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------ |
| `branch`    | The session pushed to the PR's head branch (from the session's `outcomes` in the API).     |
| `created`   | The session's events show it opening the PR (`create_pull_request` / `gh pr create` result). |
| `backlink`  | The PR description or commits contain a `https://claude.ai/code/session_…` URL.            |
| `mentioned` | The PR URL appears somewhere else in the session (can be turned off in settings).          |

1. **Sessions API sync:** a content script on `claude.ai` calls the same endpoints the claude.ai/code web app
   uses (`GET /v1/sessions`, `GET /v1/sessions/{id}/events`), authenticated by your existing claude.ai login.
   The sync is incremental: it only rescans a session's events after that session's `updated_at` changes. It runs
   when you open claude.ai, then again at most every *N* minutes (15 by default) while a claude.ai tab is open.
   **Sync now** in the popup uses an open claude.ai tab, or opens one in the background and closes it when done.
2. **Passive capture on claude.ai:** while a session page is open, any PR links shown in the conversation are
   recorded. This still works if the API sync breaks.
3. **Passive capture on GitHub:** a PR page's session links (Claude Code adds `Claude-Session:` trailers and a
   session URL to PR bodies) are recorded as backlinks.
4. **Branch matching at lookup time:** on a PR page the head branch is read from the page and matched against the
   branches that synced sessions pushed to in the same repo.

All data stays in `chrome.storage.local`. The extension makes no network requests of its own except the sync
calls to `claude.ai`.

## Install (unpacked)

1. `git clone` this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the repo folder.
3. Open [claude.ai/code](https://claude.ai/code) while signed in. The first sync starts automatically. Or click
   the extension icon and press **Sync now**.
4. Open a PR that one of your sessions created.

To build a zip for the Chrome Web Store: `npm run package`, which writes `dist/extension.zip`.

## Development

```
npm test           # unit tests (node:test, no dependencies)
npm run test:e2e   # loads the extension in Chromium via Playwright against fake claude.ai / github.com
npm run icons      # regenerate icons/*.png
```

```
manifest.json
src/
  background.js          service worker: storage, lookups, sync orchestration
  shared/core.js         pure helpers: URL parsing, relation store, matching
  shared/claude-api.js   Claude Code sessions API client + incremental sync
  content/claude.js      claude.ai: runs the sync, captures PR links on session pages
  content/github.js      github.com: PR-page chip, inline link icons, backlink capture
  content/github.css
  popup/                 toolbar popup
test/                    unit tests
e2e/run.js               browser end-to-end test
```

## Caveats

- The Claude Code sessions API is not a public API. If claude.ai changes it, the sync will report an error in
  the popup, and links will keep coming from passive capture (sources 2–4) until the client is updated.
- GitHub's markup changes too. The PR-page code tries several selectors for the title and head branch. If it
  can't find the title, the chip floats in the bottom-right corner instead.
