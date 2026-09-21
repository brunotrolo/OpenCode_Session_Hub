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

## Ported from opencode-synced

Three capabilities adapted from the upstream plugin (which runs *inside*
OpenCode itself as a `@opencode-ai/plugin` — a fundamentally different
runtime from this VS Code extension, so these are re-implementations, not
direct ports):

- **GitHub repo-privacy verification** (`githubRepoVisibility.ts`, adapted
  from `repo.ts`'s `ensureRepoPrivate`): "I confirmed the remote repo is
  PRIVATE" is an honor-system checkbox — a user can tick it for a repo
  that's actually public by mistake. Where the remote is a `github.com`
  URL and the `gh` CLI is installed and authenticated,
  `resolveSecretsAllowed` (in `syncManager.ts`) verifies the claim via
  `gh repo view --json isPrivate` before ever trusting it, and fails
  closed (no secrets/session sync this round) if GitHub disagrees. Any
  failure to check at all — `gh` missing, not authenticated, network down,
  a non-GitHub remote, a timeout (capped at 8s so an unreachable `gh` can't
  hang a sync) — falls back to the checkbox exactly as it always worked;
  this can only make the gate stricter, never looser.
- **Oversized-history detection** (`inspectOversizedUnpushedHistory` in
  `syncManager.ts`, adapted from `repo.ts`'s
  `inspectOversizedUnpushedHistory`): `OVERSIZED_FILE_SKIP_BYTES` only
  stops a *new* oversized file from being added — it does nothing about one
  that's already sitting in an unpushed commit (predating the guard, or
  from some other means entirely). Before pushing, this scans
  `origin/<branch>..HEAD` (via `git ls-tree -r -l` on each revision, capped
  at `MAX_HISTORY_SCAN_COMMITS` so a long unpushed history can't slow down
  every push) for any blob over the limit, and refuses the push with a
  clear message naming the file and the remediation (`git filter-repo`, or
  resetting the local mirror if no other machine needs that history) —
  instead of a slow, doomed upload GitHub was always going to reject.
- **MCP credential extraction** (`mcpSecretGuard.ts`, adapted from
  `mcp-secrets.ts`): `opencode.json`/`.jsonc` sync unconditionally (they
  aren't gated behind `includeSecrets`), so any real credential in
  `mcp.*.headers`/`mcp.*.oauth.clientSecret` used to reach the sync repo in
  plaintext regardless of the secrets gate. `copyFile` now runs this
  specifically for those two filenames on push, swapping any such value for
  OpenCode's own `{env:VAR}` placeholder syntax — valid, meaningful JSON,
  not the lossy blanket redaction `sanitizeJsonFile` does elsewhere — before
  the file reaches the repo. The local file this machine actually uses is
  never touched. Falls back to a plain copy if the file isn't valid JSON
  (e.g. `.jsonc` with comments), rather than risk corrupting it. Their
  plugin also *restores* these at OpenCode's own config-load time; we have
  no equivalent hook (we're external to OpenCode), so a machine receiving a
  synced `opencode.json` needs the corresponding environment variable set
  for that MCP server to keep working — the same trade-off using `{env:VAR}`
  already implies for anyone relying on it today.

## What gets synced

Mirrors [iHildy/opencode-synced](https://github.com/iHildy/opencode-synced)'s
item set (`opencodePaths.ts`'s `buildSyncPlan`), so a repo stays compatible
both ways: config files/dirs, `~/.agents`, model favorites, and — only once
`includeSecrets` + `privateRepoAcknowledged` are both true — session
artifacts.

## Per-session favorite sync

`opencode.db` is one file for the whole machine's history — if it's stuck
over the sync size limit (see below), NOTHING in it reaches another machine
until that's fixed. Favoriting a session (`favoriteSessionExport.ts`,
wired into `syncManager.ts`'s `mirrorFavoriteSessions`/
`applyFavoriteSessions`) routes around that: each favorited session is
exported to its own file, `data/favorite-sessions/<sessionId>.db`, keyed by
session id, independent of whether the whole-database sync ever succeeds.

- **One file per session, not one blob.** A single favorite's export
  failing (session not found locally, unreadable, etc.) produces one skip
  message and never blocks any other favorite — the opposite of the
  whole-database path, where one problem stops everything.
- **Reuses the row-level merge, not a separate import path.** The export
  copies each relevant table's *exact* `CREATE TABLE` statement out of the
  source database (`sqlite_master.sql`), so the resulting file has the
  correct real schema — `dbMerge.ts`'s `mergeSessionDatabases()` can then
  merge it into another machine's `opencode.db` with zero session-specific
  code. On a genuinely fresh machine with no `opencode.db` yet (merge needs
  the target's tables to already exist), the first favorite file applied
  bootstraps it via a plain copy; the rest merge into that.
- **Same privacy gate as full session sync**: only exported when
  `includeSecrets` + `privateRepoAcknowledged` are both true, since a
  favorited session is still message content.
- **Still guarded by the same size limit per file** (defensive — a single
  session is essentially never 90 MB, but a runaway one with huge tool
  output shouldn't reproduce the exact problem this feature exists to route
  around).

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

  It checkpoints with `TRUNCATE` before vacuuming, not the `PASSIVE` mode
  `syncManager.ts` uses during a live sync — `PASSIVE` only merges WAL
  content into the main file without ever shrinking the WAL file itself,
  which is exactly how a real report ended up with a 7 GB `opencode.db-wal`
  bigger than the main database. `TRUNCATE` is safe to demand here
  specifically because the caller has already told the user to close
  OpenCode first, unlike a background sync that must never block a live
  writer. Even then, SQLite won't actually truncate the WAL file while ANY
  other connection has it open — including a merely idle one with no
  transaction in flight — so a successful, non-busy checkpoint doesn't
  guarantee the file shrinks. This is checked against the real outcome (the
  WAL's size after checkpointing), not just the checkpoint pragma's own
  `busy` flag, and surfaces as a `walWarning` pointing at the likely cause: a
  lingering OpenCode process the user hasn't actually closed, not a stuck
  transaction. `debugInfo.ts` also flags a WAL over the sync limit on its
  own, independent of ever having run Compact Database, since a WAL that
  large (especially one comparable to or bigger than the main file) is
  itself a sign nothing has ever fully checkpointed it.

  `node:sqlite`'s `exec()`/`prepare().get()` are fully synchronous, and
  VACUUM on a multi-GB database is a lot of pure disk I/O — potentially
  minutes. Running that inline in the extension host, as this was first
  shipped, blocks the entire Node event loop for the whole duration: every
  other extension, all UI messages, and even the "compacting..." progress
  notification itself (rendering it also round-trips through the same
  blocked event loop). A real report confirmed this looks exactly like "the
  button did nothing" — nothing visibly happens, because nothing CAN render
  while it's blocked. `vacuumDatabase()` now runs the actual checkpoint+VACUUM
  in a separate child process (`runVacuumWorker`, an inline script passed via
  `-e`) instead, keeping the extension host responsive throughout.
  `ELECTRON_RUN_AS_NODE=1` makes VS Code's own bundled Electron binary behave
  as a plain Node CLI for that one child process, so this needs no separate
  Node install and runs the exact same `node:sqlite` build already running
  the extension host — just off its main thread.
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
- **Retries `git add -A` past "confused by unstable object source data"**
  (`gitAddAllWithRetry`): a real-world Windows report hit this exact git
  error repeatedly even after the concurrency queue (below) ruled out this
  tool racing itself. It's a known Windows gotcha: antivirus (Windows
  Defender's real-time scanner especially) or a sync client like OneDrive
  briefly opening a working-tree file at the moment git is hashing it makes
  git see the size change mid-read and refuse to trust it — not real
  corruption, just a momentary external read race. A short retry (matching
  the tolerance already given to individual locked-file copies) absorbs it;
  any other `git add` failure surfaces immediately, never masked behind a
  retry.
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
