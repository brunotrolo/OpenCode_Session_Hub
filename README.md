# OpenCode Session Hub

A VS Code extension that turns [OpenCode](https://opencode.ai) session history
into something closer to a "Google Drive for your AI sessions": browse every
session on the machine regardless of which folder the terminal was opened in,
preview conversations without spinning up a new agent run, and keep sessions
synced in the background between a work PC and a home PC through a private
Git repository.

Built on the idea from [iHildy/opencode-synced](https://github.com/iHildy/opencode-synced),
adapted to run as a VS Code extension instead of an OpenCode plugin, with an
added global session browser.

## Why

`opencode session list` only shows sessions for the project matching the
current working directory, because OpenCode scopes the query by workspace.
All sessions from every project actually live in the same global storage
tree — this extension reads that tree directly.

## Features

- **Global session browser** (`OpenCode: List All Sessions`) — QuickPick
  listing every session across every project on the machine, sorted by last
  update, with the option to resume in a terminal, preview the conversation,
  or open the originating folder in a new window.
- **Cross-OS path resolution** — if a session was recorded on another machine
  (e.g. `C:\Projetos\repo` at home vs `/home/user/repo` at work), the
  extension matches it to a local folder by name instead of failing on a
  path that doesn't exist here.
- **Read-only conversation preview** — a webview panel rendering a session's
  messages, so you can check status or copy a snippet without opening a
  terminal.
- **Background Git sync** — debounced push when the VS Code window loses
  focus, automatic pull on startup, and manual `OpenCode Sync: Push/Pull Now`
  commands. Mirrors session JSON into a separate sync repository rather than
  syncing the live OpenCode storage directly, so a WAL/lock file is never
  committed mid-write.
- **Secret sanitizer** — before anything is committed to the sync repo, API
  keys, bearer tokens, GitHub/Slack tokens, AWS keys, and DB connection
  strings with embedded credentials are redacted.
- **Handoff checkpoints** — `OpenCode: Generate Handoff Checkpoint` writes a
  human-readable Markdown summary of a session to `.opencode/HANDOFF.md` as a
  fallback if JSON sync ever fails.
- **Full-text search** (`OpenCode: Search All Session History`) — search
  every message across every session for a keyword.
- **Status bar indicator** — shows sync state (synced / syncing / error /
  unconfigured) and lets you trigger a push with one click.

## Setup

1. Create a **private** Git repository to act as the sync destination (do
   this once, from either machine).
2. In VS Code settings, set:
   - `opencodeSessionHub.syncRemoteUrl` — the private repo's URL.
   - `opencodeSessionHub.storagePath` — only needed if OpenCode's storage
     isn't at the default location for your OS.
3. Run **OpenCode Sync: Initialize Sync Repository** once.
4. On the second machine, set the same `syncRemoteUrl` and run
   **OpenCode Sync: Pull Now**.

From then on, sync happens automatically: pull on startup, debounced push
when the window loses focus (default 20s of inactivity).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `opencodeSessionHub.storagePath` | auto-detected | Override OpenCode's global storage directory |
| `opencodeSessionHub.syncRepoPath` | extension global storage | Local mirror folder for the sync repo |
| `opencodeSessionHub.syncRemoteUrl` | _(empty)_ | Git URL of the private sync repository |
| `opencodeSessionHub.autoSyncOnFocusLost` | `true` | Debounced push when the window loses focus |
| `opencodeSessionHub.autoPullOnStartup` | `true` | Pull latest state on VS Code startup |
| `opencodeSessionHub.debounceSeconds` | `20` | Inactivity window before auto-push |
| `opencodeSessionHub.redactSecrets` | `true` | Strip credential-shaped strings before syncing |

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

## Safety notes

- The extension never writes back into OpenCode's live storage — sync only
  copies OUT of it into the separate sync repo, and pulls only ever land in
  that same sync repo.
- WAL/SHM/lock files are always skipped during sync to avoid touching a
  SQLite database mid-write.
- Treat the sync repository as sensitive even with redaction enabled —
  redaction covers known credential shapes, not arbitrary secrets that might
  appear in conversation text.
