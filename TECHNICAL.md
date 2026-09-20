# Technical Notes

Implementation details worth knowing before changing the sync logic. The
code itself documents the *how* — this covers the *why*, briefly. See
`src/*.ts` for the actual mechanics.

## Storage layouts supported

OpenCode's on-disk format changed twice. One machine can hold all three at
once (migrations copy forward, never delete). `sessionScanner.ts` reads all
three and de-duplicates by session id, newest generation winning:

| Generation | Location |
| --- | --- |
| SQLite | `~/.local/share/opencode/opencode.db` |
| Storage JSON | `~/.local/share/opencode/storage/session/<projectID>/<sessionID>.json` |
| Legacy JSON | `~/.local/share/opencode/project/<hash>/storage/session/info/<sessionID>.json` |

Paths follow XDG (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `opencode_config_dir`)
on every platform, including Windows (`opencodePaths.ts`).

Reading `opencode.db` uses `node:sqlite`, which requires Node 22.5+. Older
Node just skips SQLite sessions with a warning; JSON-layout sessions still
list normally.

## What gets synced

Mirrors [iHildy/opencode-synced](https://github.com/iHildy/opencode-synced)'s
item set (`opencodePaths.ts`'s `buildSyncPlan`), so a repo stays compatible
both ways: config files/dirs, `~/.agents`, model favorites, and — only once
`includeSecrets` + `privateRepoAcknowledged` are both true — session
artifacts.

Key safety properties, implemented in `syncManager.ts`:

- **WAL-aware db sync**: attempts a passive SQLite checkpoint before syncing
  `opencode.db`, so a live session gets backed up between writes instead of
  being skipped indefinitely.
- **Locked-file retry**: a file copy that fails (e.g. a Windows sharing
  violation) retries a few times, then degrades to a per-file skip message
  instead of failing the whole sync.
- **Merge, not mirror, for session directories**: a file missing locally is
  never deleted from the repo, so one machine can't wipe another's history.
- **Local-edit protection**: a file touched since this machine's last
  successful pull is never overwritten by a later pull (except the very
  first pull ever, which adopts the remote unconditionally).
- **Session-level merge for `opencode.db`** (`dbMerge.ts`): `opencode.db` is
  a single binary SQLite file, so a plain `git merge` can only offer "keep
  local" or "keep remote" on it — either choice silently discards every
  session the other machine created since the last sync. Instead, both a
  push (`mirrorToRepo`) and a pull (`applyFromRepo`) merge the two
  databases' `session`/`message`/`part`/`project` tables row-by-row, keyed
  by id with the newer `time_updated` winning on an actual collision. This
  also runs automatically when `git merge` itself reports a real conflict on
  `data/opencode.db` (`tryAutoResolveDatabaseConflict`, invoked from
  `fetchAndIntegrate`): the two conflicting blobs are extracted with `git
  show :2:`/`:3:` (never through a string — that would corrupt the binary
  content), merged, and re-staged, finishing the merge with no data lost and
  no user action needed. Because merging can leave the local git branch
  ahead of `origin` with nothing new to *stage* that round, `push()` checks
  `commitsAheadOfOrigin()` in addition to "anything staged," so that
  resolution commit still gets pushed instead of stranding it locally.
  Falls back to the old whole-file "keep a side" behavior if `node:sqlite`
  is unavailable (Node < 22.5) or a database can't be read.
- **Conflict resolution** (`OpenCode Sync: Resolve Conflicts`, for whatever
  isn't already handled by the automatic database merge above) applies the
  winning side to local disk and pushes it, so the same conflict doesn't
  reappear next sync.

`OpenCode: Show Sync Debug Info` (also a button in the panel) surfaces the
facts a green "Synced" badge can hide — e.g. when `opencode.db` was actually
last committed, versus just "the last sync attempt didn't error."

## Session deletion

Deleting a session (from the sidebar or `OpenCode: List All Sessions`)
removes its files from this machine only — see `deleteSession()` in
`sessionScanner.ts`. It does not touch the sync repo or other machines,
consistent with the merge-not-mirror rule above: deletion isn't something
the sync plan is asked to propagate.

## Not implemented

Deliberately out of scope; use the `opencode-synced` plugin if you need:

- Turso session backend
- Chunking files above 50 MiB
- `gh`-driven automatic private repo creation
- Encrypted secrets backends, `auth.json` / `mcp-auth.json` sync
- Per-machine `opencode-synced.overrides.jsonc`

## Testing

`npm test` runs against fake OpenCode installs covering all three storage
layouts, plus a real two-machine sync against a local bare Git repository —
so sync behavior is verified, not assumed. See `src/test/`.
