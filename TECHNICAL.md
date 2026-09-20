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
- **No line-ending rewriting**: `ensureRepo()` pins `core.autocrlf=false` on
  the sync repo regardless of the user's global git config. Without it, a
  Windows machine with the (very common) global `core.autocrlf=true` would
  rewrite every text file's line endings on checkout and back on commit,
  making the sync repo look perpetually dirty between machines that don't
  share that setting.
- **Cross-platform-safe directory mappings** (`pathMapper.ts`): a mapping's
  `to` value and a search root are strings the user typed for a specific
  destination convention (which can differ from the host OS — e.g. a POSIX
  path typed on a Windows + Git Bash/WSL setup), so they're joined with
  `joinPreservingStyle`, not `path.join`, which would silently normalize
  them to the host's native separator and produce a path that never matches.
- **Oversized-file skip** (`OVERSIZED_FILE_SKIP_BYTES`, 90 MB): GitHub
  hard-rejects any single file over 100 MB, and `git add` fully re-hashes and
  re-compresses a changed binary file on every commit (no binary diffing) —
  so an `opencode.db` that's grown into the hundreds of MB or GB doesn't just
  fail to push, it can spend real time and disk doing that work first, on
  every sync attempt. `mirrorToRepo` skips any file over the limit before
  either the merge or copy path touches it, with a clear per-sync message
  (`checkOversizedFile`) and a standing entry in the debug report
  (`oversizedFileSummary`) that shows up even before the first sync ever
  runs. `opencode-synced` solves the same problem more completely with a
  chunking scheme (`src/sync/chunks.ts`, files up to 4 GB); this is the
  narrower fix — surface the problem clearly and never make it worse,
  without taking on chunking's complexity. The other half of "never make it
  worse" is giving the user a way back under the limit: **Compact Database**
  (`dbMaintenance.ts`'s `vacuumDatabase`) runs SQLite's own `VACUUM` on
  `opencode.db` in place. A multi-GB database is almost always freelist
  bloat from deleted rows rather than that much real history, and VACUUM is
  the standard tool for reclaiming it — this just means the user doesn't
  need the separate `sqlite3` CLI installed to run it. It's local-only (a
  sync still has to run afterward to publish the smaller file) and refuses
  cleanly with a "close OpenCode and try again" message if the database is
  locked, rather than corrupting anything.
- **Stale `.git/index.lock` recovery** (`clearStaleIndexLock`,
  `STALE_INDEX_LOCK_AGE_MS` = 2 minutes): plain git leaves this lock behind
  forever if the process holding it is killed mid-operation (VS Code
  force-quit, a crashed extension host, or — before the size skip above
  existed — a `git add` on a multi-GB file outliving a superseded debounced
  sync). Every sync after that fails identically with no way to recover
  short of finding and deleting the file by hand. `ensureRepo()` checks the
  lock's age on every call and removes it if it's older than the threshold;
  a fresh lock is left alone so a real concurrent operation isn't raced.
  Plain git doesn't record which process holds this lock the way
  `opencode-synced`'s own PID-tagged lock file does (`src/sync/lock.ts`), so
  age is the only signal available here — safe specifically because the size
  skip above means no legitimate operation should hold it anywhere near this
  long.
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
