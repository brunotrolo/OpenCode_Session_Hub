# OpenCode Session Hub

A VS Code extension that makes [OpenCode](https://opencode.ai) sessions behave
like a "Google Drive for AI sessions": browse **every** session on the
machine regardless of which folder the terminal was opened in, preview
conversations without starting an agent run, and keep sessions and config
synced between machines through your own private Git repository.

## Features

- **Sidebar panel** (Activity Bar icon, or **OpenCode: Open Session Hub
  Panel**) — connection, schedule, security, live sync health, recent
  sessions, and favorite sessions, all in one place.
- **Global session browser** (`OpenCode: List All Sessions`) — every
  session across every project, newest first. Resume, preview, open the
  folder, generate a handoff, or delete.
- **Favorite sessions** — bookmark a session with your own comment so it's
  easy to find later, even if it's scrolled out of the recent list.
- **Cross-machine sync** — pull on startup, push when the window loses
  focus, or trigger manually. Session history only syncs once you confirm
  the remote repository is private.
- **Cross-OS path resolution** — resumes a session recorded on another
  machine even when the folder path is different there.
- **Conversation preview** and **full-text search** across every session.
- **Handoff checkpoints** — write a session summary to `.opencode/HANDOFF.md`.
- **Delete a session** — removes it from this machine's history and drops
  any favorite pointing at it.
- **Debug info** — see exactly what's really been synced when the status
  badge alone isn't enough.
- **Compact Database** — shrinks `opencode.db` in place (`VACUUM`) when it's
  grown too large to sync (over 90 MB is skipped automatically — see
  TECHNICAL.md). Close OpenCode first, then run it from the sidebar or
  **OpenCode Sync: Compact Database (VACUUM)**.

See [TECHNICAL.md](TECHNICAL.md) for storage formats, sync internals, and
safety guarantees.

## Installing

This extension is not on the Marketplace — install the `.vsix` directly:

1. Download `opencode-session-hub-<version>.vsix` from
   [Releases](https://github.com/brunotrolo/OpenCode_Session_Hub/releases).
2. VS Code → Extensions → `···` → **Install from VSIX...**, or:
   ```bash
   code --install-extension opencode-session-hub-<version>.vsix
   ```

To build it yourself:

```bash
npm install
npm run package
```

## Setup

1. Create a **private** Git repository for syncing.
2. Run **OpenCode Sync: Initialize Sync Repository** (first machine) or
   **OpenCode Sync: Link This Machine to an Existing Repository** (second
   machine), and paste the URL.
3. To sync session history, enable both `includeSecrets` and
   `privateRepoAcknowledged` in Settings — only after verifying the remote
   is actually private.

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

## Development

```bash
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch an Extension Development Host.
