# OpenCode Session Hub

A VS Code extension that makes [OpenCode](https://opencode.ai) sessions behave
like a "Google Drive for AI sessions": browse **every** session on the machine
regardless of which folder the terminal was opened in, preview conversations
without starting an agent run, and keep sessions and config synced in the
background between a work PC and a home PC through a private Git repository.

The sync model follows [iHildy/opencode-synced](https://github.com/iHildy/opencode-synced),
reimplemented as a VS Code extension and extended with a machine-wide session
browser.

## Why

`opencode session list` only shows sessions for the project matching the
current working directory, because OpenCode scopes the query by workspace.
Every session on the machine actually lives in the same global storage, so
this extension reads that storage directly.

## Storage layouts supported

OpenCode's on-disk format changed twice, and one machine can hold all three at
once (migrations copy forward rather than delete). All three are read and
de-duplicated, newest generation winning:

| Generation | Location |
| --- | --- |
| SQLite | `~/.local/share/opencode/opencode.db` (`session` / `message` / `part` tables) |
| Storage JSON | `~/.local/share/opencode/storage/session/<projectID>/<sessionID>.json`, `storage/message/<sessionID>/`, `storage/part/<messageID>/` |
| Legacy JSON | `~/.local/share/opencode/project/<hash>/storage/session/info/<sessionID>.json` |

Paths follow XDG (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `opencode_config_dir`) on
**every** platform — including Windows, where OpenCode uses
`%USERPROFILE%\.local\share\opencode`, not `%LOCALAPPDATA%`.

> Reading `opencode.db` uses Node's built-in `node:sqlite`, which requires
> Node 22.5+. On a VS Code build with older Node, the JSON layouts still list
> normally and a warning explains that the database was skipped.

## Features

- **Sidebar control panel** — a dedicated Activity Bar icon opens the
  "OpenCode Session Hub" view: connection (remote URL + branch), schedule
  (debounce, auto-pull/auto-push toggles), the security fail-closed gate,
  live sync health (status, ahead/behind, last sync, last error), and the
  most recent sessions with one-click Preview/Resume, and freely-curated
  **favorite sessions** (a comment + a session id you add by hand — handy for
  a session that scrolled out of the "most recent" list) — everything below,
  without leaving the sidebar. Open it via the Activity Bar icon or
  **OpenCode: Open Session Hub Panel**.
- **Global session browser** (`OpenCode: List All Sessions`) — every session
  across every project, newest first. Resume in a terminal, preview, open the
  folder, or write a handoff.
- **Cross-OS path resolution** — configured prefix rewrites
  (`C:\Projetos` ⇄ `/home/user/projects`), then open-workspace name matching,
  then configured search roots. If nothing resolves, you're offered a preview
  or a folder picker instead of a broken `cd`.
- **Read-only conversation preview** — a webview with a strict
  `default-src 'none'` CSP. Message text is read from OpenCode's *part* files,
  where it actually lives.
- **Background Git sync** — pull on startup, debounced push when the window
  loses focus, plus explicit init / link / push / pull / status / resolve
  commands. A pull **applies** the repo to the local OpenCode directories, so
  the other machine's sessions really show up.
- **Fail-closed secrets** — session history counts as secret data and does not
  leave the machine until you enable `includeSecrets` **and** confirm the
  remote is private via `privateRepoAcknowledged`. The reason is always
  surfaced, never silent.
- **Secret sanitizer** — API keys, GitHub/Slack tokens, AWS keys, JWTs,
  private keys and credential-bearing connection strings are redacted from
  session payloads before commit. Config files are never rewritten (a redacted
  `opencode.json` would be pushed and then applied on the other machine).
- **Conflict resolution** — a real conflict is reported, not silently
  discarded. `OpenCode Sync: Resolve Conflicts` takes one side wholesale,
  then finishes the interrupted sync: applies the resolution to the local
  OpenCode directories and pushes it, so the conflict doesn't reappear on
  the next sync.
- **Handoff checkpoints** — a Markdown summary at `.opencode/HANDOFF.md`.
- **Full-text search** across every session's messages.
- **Status bar indicator** — synced / syncing / conflict / error / unconfigured.
- **Debug info** — `OpenCode: Show Sync Debug Info` (also a button in the
  panel's Health section) dumps the facts a status badge can't show: real
  `opencode.db`/`-wal` size and mtime on disk, whether session sync is
  actually enabled, the sync repo's HEAD commit, and — the direct answer to
  "is my live session really backed up" — the timestamp of the **last
  commit that actually touched `data/opencode.db`** in the sync repo. A
  green "Synced" badge only means the last sync *attempt* didn't error; it
  does not mean every file was included in it.

## What gets synced

Mirrors the upstream plugin's item set, so a repo stays compatible both ways:

- `~/.config/opencode/`: `opencode.json`, `opencode.jsonc`, `AGENTS.md`,
  `opencode-session-hub-favorites.json` (the sidebar's favorite sessions
  list), and the `agent(s)`, `command(s)`, `mode(s)`, `tool(s)`, `themes`,
  `plugin(s)`, `skills` directories
- `~/.agents/`
- `~/.local/state/opencode/model.json` (model favorites)
- Session artifacts, **only when secrets are enabled and acknowledged**:
  `opencode.db` plus `storage/session`, `storage/message`, `storage/part`,
  `storage/session_diff`, `storage/project`

Safety rules that apply on every sync:

- `-wal`, `-shm`, `.lock` and `.tmp` files are never committed. Before
  syncing `opencode.db`, a **PASSIVE SQLite checkpoint** is attempted first —
  safe and non-blocking, it doesn't require OpenCode to be closed. If that
  checkpoint fully drains the WAL (nothing was busy), the `.db` file alone
  is already a complete, consistent snapshot and syncs normally, even while
  OpenCode is actively running. Only a database with a *currently* active
  writer or a pinned reader — the checkpoint genuinely couldn't finish — is
  skipped with a warning, rather than copied mid-write. (Earlier versions
  skipped the db whenever any `-wal` file merely existed, which during an
  active session is nearly always — meaning a live database could go
  effectively unsynced indefinitely while the panel still read "Synced".
  Use **Show Sync Debug Info** to check when `opencode.db` was actually
  last committed if you want to confirm this yourself.)
- Session directories **merge** rather than mirror — files missing locally are
  never deleted from the repo, so one machine can't wipe the other's history.
- A local file edited since this machine's last successful pull is never
  overwritten by a later pull — protected against a stale sync clobbering
  work in progress. The very first pull to a new machine (`/sync-link`) is
  the deliberate exception: it adopts the remote unconditionally.

## Installing

This extension is not on the Marketplace — install the `.vsix` file directly:

1. Download `opencode-session-hub-<version>.vsix` from the
   [Releases page](https://github.com/brunotrolo/OpenCode_Session_Hub/releases)
   (attached automatically to every published release — see below).
2. In VS Code: Extensions view → `···` menu → **Install from VSIX...** → pick
   the downloaded file. Or from the terminal:
   ```bash
   code --install-extension opencode-session-hub-<version>.vsix
   ```

### Building the .vsix yourself

```bash
npm install
npm run package   # runs vsce package, writes opencode-session-hub-<version>.vsix
```

### Publishing a release with the .vsix attached

The `.github/workflows/release.yml` workflow builds and attaches the `.vsix`
automatically whenever a GitHub Release is published:

1. Bump `version` in `package.json`.
2. Push a tag (e.g. `git tag v0.2.0 && git push origin v0.2.0`) and create a
   GitHub Release from it (or use `gh release create v0.2.0`).
3. CI runs the tests, packages the `.vsix`, and uploads it as a release asset.

This does **not** publish to the VS Code Marketplace — it only produces an
installable file attached to the release.

## Setup

1. Create a **private** Git repository for syncing.
2. Run **OpenCode Sync: Initialize Sync Repository** (first machine) or
   **OpenCode Sync: Link This Machine to an Existing Repository** (second
   machine) and paste the URL.
3. To include session history, set both `opencodeSessionHub.includeSecrets`
   and `opencodeSessionHub.privateRepoAcknowledged` to `true` — only after
   verifying the remote really is private.

After that: pull on startup, debounced push when the window loses focus.
Restart OpenCode after a pull so it reloads the new state.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `dataPath` | auto | Override the OpenCode data directory |
| `syncRemoteUrl` | _(empty)_ | Git URL of the private sync repository |
| `syncBranch` | `main` | Branch used in the sync repository |
| `syncRepoPath` | extension storage | Local mirror of the sync repo |
| `includeSecrets` | `false` | Allow secret-class data (incl. sessions) to sync |
| `privateRepoAcknowledged` | `false` | Confirms the remote is private |
| `includeSessions` | `true` | Sync session history (still gated by the two above) |
| `includeModelFavorites` | `true` | Sync `state/model.json` |
| `includeOpencodeSkills` | `true` | Sync `~/.config/opencode/skills` |
| `includeAgentsDir` | `true` | Sync `~/.agents` |
| `directoryMappings` | `[]` | Cross-machine path rewrites |
| `projectSearchRoots` | `[]` | Folders searched for a matching project name |
| `autoPullOnStartup` | `true` | Pull when VS Code starts |
| `autoSyncOnFocusLost` | `true` | Debounced push when the window blurs |
| `debounceSeconds` | `20` | Inactivity window before auto-push |
| `redactSecrets` | `true` | Redact credentials from session payloads |

## Not implemented (upstream has these)

Deliberately out of scope for this extension; use the `opencode-synced` plugin
if you need them:

- Turso session backend (concurrent-safe snapshot sync)
- Chunking of files above 50 MiB into pointer + parts
- `gh`-driven automatic private repo creation and visibility verification
- Encrypted secrets backends and `auth.json` / `mcp-auth.json` syncing
- Per-machine `opencode-synced.overrides.jsonc`

## Development

```bash
npm install
npm run compile
npm test        # 72 tests: storage scanning, sanitizer, path mapping,
                # two-machine sync simulation, extension activation,
                # sidebar dashboard message protocol, favorite sessions
```

Press `F5` in VS Code to launch an Extension Development Host.

The test suite builds fake OpenCode installs covering all three storage
layouts and runs a real two-machine sync against a local bare repository, so
the sync behavior is verified rather than assumed.
