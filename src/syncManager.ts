import { spawn } from 'child_process';
import { Dirent, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { mergeManySessionDatabases, mergeSessionDatabases } from './dbMerge';
import { exportSessionFilesOffThread, removeStrayExportTempFiles, truncateEventExport } from './favoriteSessionExport';
import { loadDeletedSessions } from './deletedSessions';
import { loadFavorites } from './favorites';
import { checkGitHubRepoPrivacy } from './githubRepoVisibility';
import { sanitizeMcpSecretsInConfigText } from './mcpSecretGuard';
import { buildSyncPlan, OpenCodeLocations, SESSION_DB_REPO_PATH, SyncItem } from './opencodePaths';
import { sanitizeJsonFile } from './secretSanitizer';
import { deleteSession, scanSessions } from './sessionScanner';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'unconfigured' | 'conflict';

export interface SyncSettings {
  remoteUrl: string;
  branch: string;
  repoDir: string;
  includeSecrets: boolean;
  includeSessions: boolean;
  includeModelFavorites: boolean;
  includeOpencodeSkills: boolean;
  includeAgentsDir: boolean;
  redactSecrets: boolean;
  /**
   * Child sessions (forks, subagent runs) sync like any other session unless
   * this is false. Optional so older callers constructing SyncSettings keep
   * compiling; absent means ON.
   */
  includeChildSessions?: boolean;
  /** Fail-closed gate: secrets/sessions never sync until the user confirms the remote is private. */
  privateRepoAcknowledged: boolean;
}

export interface SyncOutcome {
  status: 'ok' | 'no-changes' | 'conflict';
  /** Notes worth surfacing (skipped items, fail-closed decisions). */
  messages: string[];
  changedFiles: number;
}

export interface SyncRepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  conflicted: boolean;
}

export class SyncError extends Error {}

/** A live SQLite sidecar can be mid-write; these are never committed. */
const VOLATILE_SUFFIXES = ['-wal', '-shm', '.lock', '.tmp'];

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class SyncManager {
  constructor(
    private readonly locations: OpenCodeLocations,
    private readonly settings: SyncSettings
  ) {}

  private get repoDir(): string {
    return this.settings.repoDir;
  }

  /**
   * Secrets (which includes session history) only sync to a repo the user has
   * explicitly acknowledged as private. Upstream opencode-synced fails closed
   * the same way, because a public sync repo would publish whole transcripts.
   */
  private async effectivePlan(): Promise<{ items: SyncItem[]; messages: string[]; secretsAllowed: boolean }> {
    const messages: string[] = [];
    const secretsAllowed = await this.resolveSecretsAllowed(messages);

    if (this.settings.includeSessions && !secretsAllowed) {
      messages.push(
        'Session history was NOT synced: it counts as secret data. Enable opencodeSessionHub.includeSecrets and confirm the remote is private.'
      );
    }

    const items = buildSyncPlan(this.locations, {
      includeSecrets: secretsAllowed,
      includeSessions: this.settings.includeSessions,
      includeModelFavorites: this.settings.includeModelFavorites,
      includeOpencodeSkills: this.settings.includeOpencodeSkills,
      includeAgentsDir: this.settings.includeAgentsDir,
    });

    return { items, messages, secretsAllowed };
  }

  /**
   * The base check is the same honor-system checkbox as always
   * (includeSecrets + privateRepoAcknowledged). Where the remote is a
   * github.com repo and the `gh` CLI is available and authenticated, this
   * additionally verifies that claim against GitHub itself — catching the
   * real mistake of checking that box for a repo that's actually public.
   * Never loosens the gate: if `gh` can't verify one way or the other
   * (not installed, not authenticated, network down), the manual checkbox
   * alone still governs, exactly as it always has.
   */
  private async resolveSecretsAllowed(messages: string[]): Promise<boolean> {
    const acknowledged = this.settings.includeSecrets && this.settings.privateRepoAcknowledged;
    if (!acknowledged || !this.settings.remoteUrl) {
      return acknowledged;
    }

    const check = await checkGitHubRepoPrivacy(this.settings.remoteUrl);
    if (check.checked && !check.isPrivate) {
      messages.push(
        'Secrets/session history were NOT synced: GitHub reports this repository is PUBLIC, despite ' +
          '"I confirmed the remote repo is PRIVATE" being checked. Make the repository private on GitHub, or ' +
          'point opencodeSessionHub.syncRemoteUrl at a different one, then sync again.'
      );
      return false;
    }
    return acknowledged;
  }

  async ensureRepo(): Promise<void> {
    if (!this.settings.remoteUrl) {
      throw new SyncError('Set opencodeSessionHub.syncRemoteUrl before syncing.');
    }

    await fs.mkdir(this.repoDir, { recursive: true });
    await this.clearStaleIndexLock();

    if (!(await exists(path.join(this.repoDir, '.git')))) {
      await this.git(['init', '-b', this.settings.branch]);
      await this.git(['remote', 'add', 'origin', this.settings.remoteUrl]);
    } else {
      const current = await this.git(['remote', 'get-url', 'origin'], { allowFailure: true });
      if (current.code !== 0) {
        await this.git(['remote', 'add', 'origin', this.settings.remoteUrl]);
      } else if (current.stdout.trim() !== this.settings.remoteUrl) {
        await this.git(['remote', 'set-url', 'origin', this.settings.remoteUrl]);
      }
    }

    // The sync repo is machine-local plumbing and may run on a box without a
    // global git identity, so give it one instead of failing at commit time.
    if ((await this.git(['config', 'user.email'], { allowFailure: true })).code !== 0) {
      await this.git(['config', 'user.email', 'opencode-session-hub@localhost']);
      await this.git(['config', 'user.name', 'OpenCode Session Hub']);
    }

    // A Windows machine's global git config very commonly defaults
    // core.autocrlf=true, which rewrites LF to CRLF on checkout and back on
    // commit. Left on, every push/pull would silently mutate line endings in
    // every text file this syncs (opencode.json, AGENTS.md, session JSON),
    // making the sync repo perpetually "dirty" between machines that don't
    // share that setting. This repo's own config always wins over the user's
    // global one, so pin it off regardless of what the user has set globally.
    await this.git(['config', 'core.autocrlf', 'false']);

    // Second line of defense behind removeStrayExportTempFiles: even if an
    // export is interrupted at the worst possible moment, `git add -A` must
    // never be able to commit a scratch file. One of these reached a real
    // repo at over GitHub's 100 MB limit and blocked every push from then on.
    //
    // This goes in .git/info/exclude rather than a committed .gitignore:
    // the rule is machine-local plumbing, nothing the other machines need,
    // and an untracked .gitignore in the working tree would block the very
    // first `git checkout -B <branch> origin/<branch>` on a fresh mirror.
    const excludePath = path.join(this.repoDir, '.git', 'info', 'exclude');
    const excludeRule = '*.tmp-*';
    const existingExclude = (await readFileOrNull(excludePath)) ?? '';
    if (!existingExclude.split('\n').some((line) => line.trim() === excludeRule)) {
      const separator = existingExclude === '' || existingExclude.endsWith('\n') ? '' : '\n';
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      await fs.writeFile(excludePath, `${existingExclude}${separator}${excludeRule}\n`, 'utf8');
    }
  }

  /**
   * Serializes repo work ACROSS PROCESSES, not just within one.
   *
   * SyncController's queue only orders operations inside a single extension
   * host. Every VS Code window runs its own, and they all share one mirror
   * directory under globalStorage — so with several windows open (normal
   * when working on more than one project) two of them run git against the
   * same repository at once. `autoSyncOnFocusLost` makes that the common
   * case rather than a rare one: switching from one window to another
   * schedules a push in the window being left while the other is active.
   *
   * A real log showed the consequence: `git add -A` failing with "confused
   * by unstable object source data", and once with a file vanishing
   * mid-index — one window's git reading what another window was still
   * writing. The lock is a file in `.git/` (never part of the working tree,
   * so it can't be committed), created atomically with the `wx` flag. A
   * holder that has gone away without releasing — a crashed or force-quit
   * window — would otherwise block this machine forever, so a lock older
   * than REPO_LOCK_STALE_MS is taken over; the holder refreshes it while it
   * works so a legitimately slow sync is never mistaken for a dead one.
   */
  private async withRepoLock<T>(operation: () => Promise<T>): Promise<T> {
    // Beside the repo directory, not inside it: a lock under .git/ would
    // have to create .git before `git init` runs (which makes ensureRepo
    // think the repo already exists), and one in the working tree could be
    // committed. A sibling file is neither.
    const lockPath = `${this.repoDir}.lock`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    const attempts = [0, 500, 1500, 3000, 5000];
    let acquired = false;
    for (const delay of attempts) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        await handle.close();
        acquired = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw err;
        }
        const stat = await statOrNull(lockPath);
        if (stat && Date.now() - stat.mtimeMs > REPO_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
        }
      }
    }

    if (!acquired) {
      throw new SyncError(
        'Another VS Code window is syncing this repository right now. Nothing was changed — this sync will ' +
          'run on its own shortly, or you can retry once the other one finishes.'
      );
    }

    // Keeps the lock visibly alive so a slow-but-healthy sync is never
    // taken over as stale by another window.
    const heartbeat = setInterval(() => {
      const now = new Date();
      fs.utimes(lockPath, now, now).catch(() => undefined);
    }, REPO_LOCK_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }

    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Removes `.git/index.lock` if it's old enough to be almost certainly
   * stale (see STALE_INDEX_LOCK_AGE_MS) rather than a real concurrent `git`
   * process. Plain git leaves this lock behind forever if the process
   * holding it is killed mid-operation — VS Code force-quit, a crashed
   * extension host, or (before OVERSIZED_FILE_SKIP_BYTES existed) a `git
   * add` on a multi-GB file outliving a debounced sync that got superseded.
   * Without this, every sync attempt from then on fails identically, with
   * no way to recover short of the user finding and deleting the file by
   * hand.
   */
  private async clearStaleIndexLock(): Promise<void> {
    const lockPath = path.join(this.repoDir, '.git', 'index.lock');
    const stat = await statOrNull(lockPath);
    if (!stat) {
      return;
    }
    if (Date.now() - stat.mtimeMs < STALE_INDEX_LOCK_AGE_MS) {
      return;
    }
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }

  /** Fetches the remote branch and merges it into the local mirror. */
  private async fetchAndIntegrate(): Promise<{ conflicted: boolean; messages: string[] }> {
    const fetch = await this.git(['fetch', 'origin', this.settings.branch], { allowFailure: true });
    if (fetch.code !== 0) {
      // Only ONE fetch failure is benign: a freshly created remote that has
      // no such branch yet. Treating every failure that way (as this used
      // to) silently turns an authentication or network problem into a
      // successful-looking sync — the push then commits locally and fails
      // at the end, so commits pile up unpushed while the panel reports
      // success. A real report reached 16 unpushed commits this way.
      if (!isMissingRemoteBranch(fetch.stderr)) {
        throw new SyncError(
          `Could not reach the sync repository: ${fetch.stderr.trim() || `git fetch exited with code ${fetch.code}`}. ` +
            'Nothing was synced. Check the remote URL, your network, and that your git credentials for ' +
            'GitHub are still valid.'
        );
      }
      return { conflicted: false, messages: [] };
    }

    if ((await this.git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).code !== 0) {
      await this.git(['checkout', '-B', this.settings.branch, `origin/${this.settings.branch}`]);
      return { conflicted: false, messages: [] };
    }

    const merge = await this.git(['merge', '--no-edit', `origin/${this.settings.branch}`], { allowFailure: true });
    if (merge.code === 0) {
      return { conflicted: false, messages: [] };
    }

    return this.tryAutoResolveDatabaseConflict();
  }

  /**
   * opencode.db is a binary file, so git can only offer "keep local" or "keep
   * remote" on it — either choice silently drops every session the other
   * machine created since the last sync. Before surfacing the conflict to the
   * user, try a session-level merge (see dbMerge.ts) of just that file: if it
   * succeeds and nothing else is conflicted, the merge finishes on its own
   * with no data lost and no user action needed.
   */
  private async tryAutoResolveDatabaseConflict(): Promise<{ conflicted: boolean; messages: string[] }> {
    const messages: string[] = [];
    const conflicted = await this.listConflictedFiles();

    if (conflicted.includes(SESSION_DB_REPO_PATH)) {
      if (await this.mergeConflictedDatabase()) {
        await this.git(['add', '--', SESSION_DB_REPO_PATH]);
        messages.push(
          `Merged ${SESSION_DB_REPO_PATH} automatically at the session level instead of picking one machine's copy.`
        );
      } else {
        messages.push(`Could not auto-merge ${SESSION_DB_REPO_PATH}; resolve it manually.`);
      }
    }

    const remaining = await this.listConflictedFiles();
    if (remaining.length === 0) {
      await this.git(['commit', '--no-edit'], { allowFailure: true });
      return { conflicted: false, messages };
    }

    return { conflicted: true, messages };
  }

  private async listConflictedFiles(): Promise<string[]> {
    return (await this.git(['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * During a merge, `:2:<path>` is this machine's pre-merge copy ("ours") and
   * `:3:<path>` is the incoming remote copy ("theirs"). Both are extracted
   * with `git show` piped straight to a file — never through a string, which
   * would corrupt SQLite's binary content — merged row-by-row, and the result
   * replaces the working-tree copy so it can be staged like any other
   * resolved file.
   */
  private async mergeConflictedDatabase(): Promise<boolean> {
    const repoPath = path.join(this.repoDir, ...SESSION_DB_REPO_PATH.split('/'));
    const oursTmp = `${repoPath}.merge-ours.tmp`;
    const theirsTmp = `${repoPath}.merge-theirs.tmp`;

    try {
      const [oursOk, theirsOk] = await Promise.all([
        this.gitShowToFile(`:2:${SESSION_DB_REPO_PATH}`, oursTmp),
        this.gitShowToFile(`:3:${SESSION_DB_REPO_PATH}`, theirsTmp),
      ]);
      if (!oursOk || !theirsOk) {
        return false;
      }
      if (mergeSessionDatabases(oursTmp, theirsTmp) === null) {
        return false;
      }
      await fs.copyFile(oursTmp, repoPath);
      return true;
    } catch {
      return false;
    } finally {
      await fs.rm(oursTmp, { force: true });
      await fs.rm(theirsTmp, { force: true });
    }
  }

  private gitShowToFile(spec: string, destPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const out = createWriteStream(destPath);
      const child = spawn('git', ['show', spec], { cwd: this.repoDir });
      let failed = false;
      child.on('error', () => {
        failed = true;
      });
      child.stdout.pipe(out);
      child.stdout.on('error', () => {
        failed = true;
      });
      child.on('close', (code) => {
        out.close(() => resolve(!failed && code === 0));
      });
    });
  }

  async push(): Promise<SyncOutcome> {
    return this.withRepoLock(() => this.pushLocked());
  }

  private async pushLocked(): Promise<SyncOutcome> {
    await this.ensureRepo();
    const { items, messages, secretsAllowed } = await this.effectivePlan();

    const integration = await this.fetchAndIntegrate();
    messages.push(...integration.messages);
    if (integration.conflicted) {
      return { status: 'conflict', messages: [...messages, CONFLICT_HINT], changedFiles: 0 };
    }

    const mirrored = await this.mirrorToRepo(items);
    messages.push(...mirrored.messages);

    // Independent of the whole-database sync above (which the oversized-file
    // skip can leave permanently stuck): sessions are exported to their own
    // small files, keyed by session id, so history still gets across even
    // when the full opencode.db never can. One session failing to export
    // never blocks any other — see mirrorFavoriteSessions.
    if (secretsAllowed && this.settings.includeSessions) {
      messages.push(...(await this.mirrorFavoriteSessions(mirrored.databaseSkipped)));
    }

    await this.gitAddAllWithRetry();
    const staged = (await this.git(['diff', '--cached', '--name-only'])).stdout.trim();
    if (staged) {
      await this.git(['commit', '-m', `sync: ${new Date().toISOString()}`]);
    }

    // A just-finished conflict merge (tryAutoResolveDatabaseConflict) commits
    // locally but never pushes, so checking only "anything staged this round"
    // would miss it: HEAD can already be ahead of origin with nothing left to
    // stage. Leaving that commit unpushed would mean the next machine to sync
    // hits the exact same conflict all over again.
    const ahead = await this.commitsAheadOfOrigin();
    if (!staged && ahead === 0) {
      return { status: 'no-changes', messages, changedFiles: 0 };
    }

    // Catches a file that was already committed to this repo's history
    // before OVERSIZED_FILE_SKIP_BYTES existed (or by some other means) —
    // that guard only stops a NEW oversized file from being added, it does
    // nothing about one already sitting in an unpushed commit. Checking
    // first avoids a slow, doomed upload attempt (GitHub rejects it anyway)
    // and — since the commit is already made — gives the one piece of
    // information git's own rejection doesn't: which unpushed commits carry
    // it and that history itself needs fixing, not just the working tree.
    const oversizedHistory = await this.inspectOversizedUnpushedHistory();
    if (oversizedHistory.oversizedPaths.length > 0) {
      throw new SyncError(
        `Refusing to push: ${oversizedHistory.unpushedCommits} unpushed commit(s) already contain file(s) over ` +
          `GitHub's size limit: ${oversizedHistory.oversizedPaths.join(', ')}. GitHub would reject the push ` +
          'anyway. Run "OpenCode Sync: Rebuild Local Mirror" (or the Rebuild Mirror button in the sidebar) to ' +
          'discard this unpushed local history and rebuild the mirror from the remote — nothing on GitHub or ' +
          'in your OpenCode data is touched, only this machine\'s scratch copy of the repo.'
      );
    }

    await this.git(['push', '-u', 'origin', this.settings.branch]);

    return { status: 'ok', messages, changedFiles: staged ? staged.split('\n').length : 0 };
  }

  /**
   * Throws away this machine's local copy of the sync repo and rebuilds it
   * from the remote.
   *
   * This is the recovery path for a mirror whose unpushed history is
   * unpushable — most concretely, one carrying a blob over GitHub's 100 MB
   * limit, which makes every push fail forever with no way forward short of
   * git surgery the user should never have to do. Because the mirror is only
   * ever a scratch copy of what's already on GitHub plus what can be
   * regenerated from local OpenCode data, deleting it is safe in a way that
   * deleting a normal repository would not be: nothing on the remote is
   * touched, and no OpenCode session data lives here.
   *
   * The one real cost is any commit that exists ONLY here and was never
   * pushed — which, when this is needed, is exactly the unpushable history
   * being discarded. The count is reported so the caller can confirm with
   * the user first.
   */
  async rebuildMirror(): Promise<{ discardedCommits: number; messages: string[] }> {
    return this.withRepoLock(() => this.rebuildMirrorLocked());
  }

  private async rebuildMirrorLocked(): Promise<{ discardedCommits: number; messages: string[] }> {
    if (!this.settings.remoteUrl) {
      throw new SyncError('Set opencodeSessionHub.syncRemoteUrl before rebuilding the mirror.');
    }

    const messages: string[] = [];
    let discardedCommits = 0;
    if (await exists(path.join(this.repoDir, '.git'))) {
      const ahead = await this.git(['rev-list', '--count', `origin/${this.settings.branch}..HEAD`], {
        allowFailure: true,
      });
      const count = Number(ahead.stdout.trim());
      discardedCommits = ahead.code === 0 && Number.isFinite(count) ? count : 0;
    }

    await fs.rm(this.repoDir, { recursive: true, force: true });
    messages.push('Deleted the local mirror.');

    // ensureRepo re-initializes it; the fetch then repopulates from the
    // remote, exactly as it does on a machine syncing for the first time.
    await this.ensureRepo();
    const integration = await this.fetchAndIntegrate();
    messages.push(...integration.messages);
    messages.push(
      discardedCommits > 0
        ? `Rebuilt from ${this.settings.remoteUrl} — ${discardedCommits} unpushed local commit(s) were discarded.`
        : `Rebuilt from ${this.settings.remoteUrl}.`
    );
    messages.push('Run a push to re-upload this machine\'s current state.');

    return { discardedCommits, messages };
  }

  /** origin/<branch> is a remote-tracking ref refreshed by fetchAndIntegrate's own fetch. */
  private async commitsAheadOfOrigin(): Promise<number> {
    if ((await this.git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).code !== 0) {
      // No commits at all yet (e.g. nothing was ever staged) — nothing to push.
      return 0;
    }
    const result = await this.git(['rev-list', '--count', `origin/${this.settings.branch}..HEAD`], {
      allowFailure: true,
    });
    if (result.code !== 0) {
      // HEAD exists but there's no local origin/<branch> ref yet — the very
      // first real push to a brand-new remote. There's clearly something to push.
      return 1;
    }
    const count = Number(result.stdout.trim());
    return Number.isFinite(count) ? count : 0;
  }

  /**
   * Adapted from opencode-synced's inspectOversizedUnpushedHistory (its
   * repo.ts). Scans commits about to be pushed (origin/<branch>..HEAD, or
   * every local commit if the branch has no remote yet) for any blob over
   * the sync size limit, via `git ls-tree -r -l` on each revision's full
   * tree. Bounded to MAX_HISTORY_SCAN_COMMITS so a very long unpushed
   * history doesn't turn every push into a slow full scan — past that, this
   * gives up and reports nothing found rather than blocking indefinitely
   * (git's own push will still surface GitHub's rejection in that case, just
   * without this extra context).
   */
  private async inspectOversizedUnpushedHistory(): Promise<{ oversizedPaths: string[]; unpushedCommits: number }> {
    if ((await this.git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).code !== 0) {
      return { oversizedPaths: [], unpushedCommits: 0 };
    }

    const remoteExists =
      (await this.git(['rev-parse', '--verify', `origin/${this.settings.branch}`], { allowFailure: true })).code === 0;
    const revListArgs = remoteExists
      ? ['rev-list', `--max-count=${MAX_HISTORY_SCAN_COMMITS + 1}`, `origin/${this.settings.branch}..HEAD`]
      : ['rev-list', `--max-count=${MAX_HISTORY_SCAN_COMMITS + 1}`, 'HEAD', '--not', '--remotes=origin'];
    const revListResult = await this.git(revListArgs, { allowFailure: true });
    const revisions = revListResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (revisions.length === 0 || revisions.length > MAX_HISTORY_SCAN_COMMITS) {
      return { oversizedPaths: [], unpushedCommits: revisions.length };
    }

    const oversizedPaths = new Set<string>();
    for (const revision of revisions) {
      const treeResult = await this.git(['ls-tree', '-r', '-l', '--full-tree', revision], { allowFailure: true });
      if (treeResult.code !== 0) {
        continue;
      }
      for (const line of treeResult.stdout.split('\n')) {
        const match = line.match(/^\d+\s+blob\s+[0-9a-f]+\s+(\d+)\t(.+)$/);
        if (!match) {
          continue;
        }
        const size = Number(match[1]);
        if (Number.isFinite(size) && size > OVERSIZED_FILE_SKIP_BYTES) {
          oversizedPaths.add(match[2]);
        }
      }
    }

    return { oversizedPaths: [...oversizedPaths].sort(), unpushedCommits: revisions.length };
  }

  /**
   * Pulls the sync repo AND applies it to the local OpenCode directories.
   * Without the apply step, arriving at the other machine downloads nothing
   * OpenCode can actually read.
   */
  async pull(): Promise<SyncOutcome> {
    return this.withRepoLock(() => this.pullLocked());
  }

  private async pullLocked(): Promise<SyncOutcome> {
    await this.ensureRepo();
    const { items, messages, secretsAllowed } = await this.effectivePlan();

    const integration = await this.fetchAndIntegrate();
    messages.push(...integration.messages);
    if (integration.conflicted) {
      return { status: 'conflict', messages: [...messages, CONFLICT_HINT], changedFiles: 0 };
    }

    const applied = await this.applyFromRepo(items);
    messages.push(...applied.messages);

    let favoriteCount = 0;
    if (secretsAllowed) {
      const favoriteApplied = await this.applyFavoriteSessions();
      messages.push(...favoriteApplied.messages);
      favoriteCount = favoriteApplied.count;
    }

    const removed = await this.applyDeletedSessions();
    messages.push(...removed.messages);

    const count = applied.count + favoriteCount + removed.count;
    return { status: count > 0 ? 'ok' : 'no-changes', messages, changedFiles: count };
  }

  /**
   * Carries out, locally, the deletions other machines recorded — the
   * tombstone file arrives with the rest of the config, and this is what
   * makes it mean something here.
   *
   * Skipping this would leave the deletion half-applied: this machine keeps
   * the session in its own opencode.db, and because the whole-database
   * mirror carries every row it holds, the very next push puts that session
   * straight back into the sync repo. The machine that deleted it then pulls
   * it back, and the deletion bounces between the two forever. Deleting it
   * here is what stops that loop, and it's also simply what the user asked
   * for when they deleted the session on the other machine.
   */
  private async applyDeletedSessions(): Promise<{ count: number; messages: string[] }> {
    const tombstoned = new Set(loadDeletedSessions(this.locations).map((entry) => entry.sessionId));
    if (tombstoned.size === 0) {
      return { count: 0, messages: [] };
    }

    const messages: string[] = [];
    let count = 0;
    for (const record of scanSessions(this.locations).sessions) {
      if (!tombstoned.has(record.id)) {
        continue;
      }
      try {
        await deleteSession(this.locations, record);
        count += 1;
      } catch (err) {
        messages.push(
          `Could not remove session ${record.id}, deleted on another machine: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return { count, messages };
  }

  /**
   * Exports every favorited session to its own file under
   * data/favorite-sessions/<sessionId>.db instead of relying on the
   * whole-database sync — the point being that a bookmark still reaches the
   * sync repo even when opencode.db itself is stuck over the size limit (see
   * OVERSIZED_FILE_SKIP_BYTES) or a particular session's export fails for
   * some other reason. Each file is independent: one failing produces one
   * skip message and never stops the rest from syncing.
   */
  private async mirrorFavoriteSessions(databaseSkipped: boolean): Promise<string[]> {
    const favorites = loadFavorites(this.locations);
    const targets = new Map<string, string>();
    for (const favorite of favorites) {
      targets.set(favorite.sessionId, favorite.label);
    }

    // When the whole-database sync was skipped (oversized, or OpenCode is
    // holding uncheckpointed writes), per-session export is the ONLY route
    // session history has to the remote — so it can't stay limited to what
    // the user happened to bookmark. Without this, the real production case
    // (a multi-GB opencode.db that never successfully compacts) syncs config
    // forever while not a single session ever reaches GitHub, reporting
    // success the whole time. Newest sessions first, bounded, so one push
    // can't turn into thousands of exports.
    const messages: string[] = [];
    if (databaseSkipped) {
      // scanSessions already sorts newest-updated first.
      const scannable = scanSessions(this.locations).sessions.filter(
        (session) => session.source === 'sqlite' || session.source === 'event-log'
      );
      for (const session of scannable.slice(0, MAX_INDIVIDUAL_SESSION_EXPORTS)) {
        if (!targets.has(session.id)) {
          targets.set(session.id, session.title);
        }
      }
      if (scannable.length > MAX_INDIVIDUAL_SESSION_EXPORTS) {
        messages.push(
          'opencode.db could not be synced as a whole, so sessions are being synced individually — the ' +
            `${MAX_INDIVIDUAL_SESSION_EXPORTS} most recently updated of ${scannable.length} were included. ` +
            'Favorite any older session you want carried across; favorites are always synced regardless of this limit.'
        );
      }
    }

    const destDir = path.join(this.repoDir, ...FAVORITE_SESSIONS_REPO_DIR.split('/'));

    // Scratch files from an older build (which wrote them beside the output,
    // inside the repo) are still on disk in an existing mirror, and every
    // `git add -A` commits them again. One real repo had five, one of them
    // over GitHub's 100 MB limit, which blocked every push.
    const strays = await removeStrayExportTempFiles(destDir);
    if (strays.length > 0) {
      messages.push(
        `Removed ${strays.length} leftover export scratch file(s) from the sync repo — an interrupted export ` +
          'left them behind, and they were being committed. They are written outside the repo now.'
      );
    }

    // A session deleted on this machine must also leave the mirror, or its
    // still-present export file re-seeds it here on the next pull and onto
    // every other machine too. Removing the file is what makes a deletion
    // actually propagate instead of silently reversing itself — so this runs
    // before the "nothing to export" bail-out below: deleting the last
    // session leaves nothing to export and still has to remove its file.
    const deleted = loadDeletedSessions(this.locations);
    if (deleted.length > 0 && (await exists(destDir))) {
      for (const entry of deleted) {
        targets.delete(entry.sessionId);
        await fs.rm(path.join(destDir, `${entry.sessionId}.db`), { force: true }).catch(() => undefined);
      }
    }

    if (targets.size === 0) {
      return messages;
    }

    // The same pass enforces includeChildSessions=false: fork/subagent
    // children stay local while their parents keep syncing.
    const scannedById = new Map(scanSessions(this.locations).sessions.map((s) => [s.id, s] as const));
    if (this.settings.includeChildSessions === false) {
      const childSkipped: string[] = [];
      for (const [id, label] of [...targets]) {
        if (scannedById.get(id)?.parentId) {
          targets.delete(id);
          childSkipped.push(`"${label}" (${id})`);
        }
      }
      if (childSkipped.length > 0) {
        messages.push(
          `Skipped ${childSkipped.length} child session(s) (includeChildSessions is off): ` +
            `${childSkipped.slice(0, 3).join(', ')}` +
            `${childSkipped.length > 3 ? ` and ${childSkipped.length - 3} more` : ''}. ` +
            'Their parents still synced.'
        );
      }
    }

    if (targets.size === 0) {
      return messages;
    }

    await fs.mkdir(destDir, { recursive: true });

    // Batched rather than one export call per session: OpenCode's schema has
    // no index on session_id, so exporting individually costs one full scan
    // of the message and part tables PER SESSION — on a real multi-GB
    // database with a few hundred sessions that alone made a push take
    // minutes. See exportSessionFilesBatched.
    const results = await exportSessionFilesOffThread(
      this.locations.databasePath,
      [...targets.keys()].map((sessionId) => ({
        sessionId,
        outputPath: path.join(destDir, `${sessionId}.db`),
        ...(scannedById.get(sessionId)?.source === 'event-log' ? { format: 'event' as const } : {}),
      }))
    );

    for (const result of results) {
      const label = targets.get(result.sessionId) ?? result.sessionId;
      if (!result.ok) {
        messages.push(`Session "${label}" (${result.sessionId}) not synced: ${result.error}`);
        continue;
      }

      // One session's worth of messages should essentially never hit this —
      // but a runaway single session (huge tool output, say) is exactly the
      // kind of thing this whole feature exists to route around, not repeat.
      const outputPath = path.join(destDir, `${result.sessionId}.db`);
      const stat = await statOrNull(outputPath);
      if (stat && stat.size > OVERSIZED_FILE_SKIP_BYTES) {
        // Event-format exports get a second chance: drop the oldest
        // message/part events until the file fits, newest context first.
        // A truncated session still merges and resumes anywhere a full one
        // does — it just starts further into its own history.
        if (scannedById.get(result.sessionId)?.source === 'event-log') {
          const truncated = await truncateEventExport(outputPath, TRUNCATED_SESSION_BUDGET_BYTES);
          const restat = await statOrNull(outputPath);
          if (truncated.ok && restat && restat.size <= OVERSIZED_FILE_SKIP_BYTES) {
            messages.push(
              `Session "${label}" (${result.sessionId}) is too large to sync whole, so the oldest ` +
                `${truncated.droppedMessages} message(s) were left out: the newest ${truncated.keptMessages} synced ` +
                `(${(restat.size / (1024 * 1024)).toFixed(0)} MB). Shorten it to sync the full history.`
            );
            continue;
          }
        }
        await fs.rm(outputPath, { force: true });
        // Deliberately not checkOversizedFile()'s wording: that one tells
        // the user to compact opencode.db, which does nothing for a single
        // session that is genuinely this large on its own (a very long
        // session with big tool outputs). The honest answer is that this
        // one session can't sync, and which one it is.
        messages.push(
          `Session "${label}" (${result.sessionId}) is too large to sync on its own: ` +
            `${(stat.size / (1024 * 1024)).toFixed(0)} MB exceeds the ` +
            `${OVERSIZED_FILE_SKIP_BYTES / (1024 * 1024)} MB limit (GitHub rejects any file over 100 MB). ` +
            'Every other session still synced. This one stays on this machine only unless you shorten it.'
        );
      }
    }

    return messages;
  }

  /**
   * Applies every data/favorite-sessions/<id>.db file from the mirror into
   * the local opencode.db, via the same row-level merge dbMerge.ts already
   * uses for the whole-database case — a per-session export uses the exact
   * same table schemas, so no separate import logic is needed. If the local
   * opencode.db doesn't exist at all yet (a genuinely fresh machine),
   * mergeSessionDatabases can't run (it needs the target's tables to already
   * exist), so the first file found bootstraps it via a plain copy and the
   * rest merge into that.
   */
  private async applyFavoriteSessions(): Promise<{ count: number; messages: string[] }> {
    const dir = path.join(this.repoDir, ...FAVORITE_SESSIONS_REPO_DIR.split('/'));
    const messages: string[] = [];
    let count = 0;

    // A session this machine deleted keeps its tombstone forever, so even if
    // another machine (or an older commit) still carries an export file for
    // it, it is never merged back in here — see deletedSessions.ts.
    const deletedIds = new Set(loadDeletedSessions(this.locations).map((entry) => entry.sessionId));

    const sourcePaths: string[] = [];
    for (const entry of await readDirEntries(dir)) {
      if (entry.isFile() && entry.name.endsWith('.db') && !deletedIds.has(entry.name.replace(/\.db$/, ''))) {
        sourcePaths.push(path.join(dir, entry.name));
      }
    }
    if (sourcePaths.length === 0) {
      return { count: 0, messages };
    }

    // A genuinely fresh machine has no opencode.db for the merge to write
    // into (mergeTable needs the target's tables to already exist), so the
    // first export bootstraps it by plain copy and the rest merge into that.
    // Only a legacy-format file can bootstrap: an event-only file carries
    // just event rows, and copying it as opencode.db would leave OpenCode
    // with a database missing every other table it expects. With no legacy
    // file and no local database there is nothing safe to build on — the
    // synced sessions apply on a later pull, once OpenCode has created its
    // database by running here.
    if (!(await exists(this.locations.databasePath))) {
      const bootstrapIndex = sourcePaths.findIndex((sourcePath) => exportFileHasTable(sourcePath, 'session'));
      if (bootstrapIndex === -1) {
        messages.push(
          'Synced sessions are waiting for a local database: OpenCode has not created opencode.db on this ' +
            'machine yet. They will apply on a later pull, after OpenCode runs here once.'
        );
        return { count, messages };
      }
      await fs.mkdir(path.dirname(this.locations.databasePath), { recursive: true });
      await fs.copyFile(sourcePaths[bootstrapIndex], this.locations.databasePath);
      count += 1;
      sourcePaths.splice(bootstrapIndex, 1);
      if (sourcePaths.length === 0) {
        return { count, messages };
      }
    }

    // One target connection for every export file — see
    // mergeManySessionDatabases on why merging them one-connection-per-file
    // stalls the extension host on a large opencode.db.
    const results = mergeManySessionDatabases(this.locations.databasePath, sourcePaths);
    if (results === null) {
      messages.push('Could not apply synced session files: node:sqlite unavailable or opencode.db is unreadable.');
      return { count, messages };
    }

    for (const result of results) {
      if (result.changed === null) {
        messages.push(`Could not apply synced session file ${path.basename(result.path)}: it is unreadable.`);
      } else if (result.changed > 0) {
        count += 1;
      }
    }

    return { count, messages };
  }

  /**
   * Resolves a conflicted merge by taking one side wholesale, then finishes
   * the sync that conflict interrupted: applies the resolution to the local
   * OpenCode directories (so a pull-side conflict doesn't leave local files
   * stuck on the pre-conflict state) and pushes the resolution commit (so a
   * push-side conflict doesn't leave it stranded, unpushed, for the next
   * sync to collide with all over again).
   */
  async resolveConflicts(keep: 'local' | 'remote'): Promise<SyncOutcome> {
    return this.withRepoLock(() => this.resolveConflictsLocked(keep));
  }

  private async resolveConflictsLocked(keep: 'local' | 'remote'): Promise<SyncOutcome> {
    await this.ensureRepo();
    let conflicted = await this.listConflictedFiles();

    if (conflicted.length === 0) {
      await this.git(['merge', '--abort'], { allowFailure: true });
      return { status: 'no-changes', messages: ['No conflicted files to resolve.'], changedFiles: 0 };
    }

    const messages: string[] = [];
    const totalConflicted = conflicted.length;

    // The database gets a real session-level merge instead of "pick a side,"
    // which would otherwise discard whichever machine's sessions weren't kept.
    if (conflicted.includes(SESSION_DB_REPO_PATH) && (await this.mergeConflictedDatabase())) {
      await this.git(['add', '--', SESSION_DB_REPO_PATH]);
      messages.push(
        `Merged ${SESSION_DB_REPO_PATH} automatically at the session level instead of picking one machine's copy.`
      );
      conflicted = conflicted.filter((file) => file !== SESSION_DB_REPO_PATH);
    }

    // During a merge, --ours is this machine's mirror and --theirs is the remote.
    const strategy = keep === 'local' ? '--ours' : '--theirs';
    for (const file of conflicted) {
      await this.git(['checkout', strategy, '--', file], { allowFailure: true });
      await this.git(['add', '--', file], { allowFailure: true });
    }
    await this.git(['commit', '--no-edit'], { allowFailure: true });

    if (conflicted.length > 0) {
      messages.push(`Resolved ${conflicted.length} conflicted file(s), keeping the ${keep} version.`);
    }

    const { items } = await this.effectivePlan();
    const applied = await this.applyFromRepo(items);
    messages.push(...applied.messages);

    const pushResult = await this.git(['push', '-u', 'origin', this.settings.branch], { allowFailure: true });
    if (pushResult.code !== 0) {
      messages.push(
        `Resolution committed locally but could not be pushed (${(pushResult.stderr || pushResult.stdout).trim()}). Sync again once that's resolved.`
      );
    }

    return { status: 'ok', messages, changedFiles: totalConflicted };
  }

  async status(): Promise<SyncRepoStatus> {
    await this.ensureRepo();
    await this.git(['fetch', 'origin', this.settings.branch], { allowFailure: true });

    const counts = await this.git(
      ['rev-list', '--left-right', '--count', `origin/${this.settings.branch}...HEAD`],
      { allowFailure: true }
    );
    const [behind, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];

    return {
      branch: this.settings.branch,
      ahead: ahead || 0,
      behind: behind || 0,
      dirty: (await this.git(['status', '--porcelain'], { allowFailure: true })).stdout.trim().length > 0,
      conflicted:
        (await this.git(['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })).stdout.trim().length > 0,
    };
  }

  /**
   * Repository-side facts for the debug report: what's actually in the
   * mirror right now, as opposed to what the panel's summary status implies.
   * In particular, "when was data/opencode.db last actually committed" is
   * the direct answer to "is my live session really backed up on GitHub,
   * or has it been silently skipped every time."
   */
  async debugReport(): Promise<string> {
    const lines: string[] = [];
    const repoExists = await exists(path.join(this.repoDir, '.git'));

    lines.push(`Repo dir: ${this.repoDir}`);
    lines.push(`Remote: ${this.settings.remoteUrl || '(not set)'}`);
    lines.push(`Branch: ${this.settings.branch}`);

    if (!repoExists) {
      lines.push('Local mirror has not been created yet (no push/pull has run).');
      // File-size checks read local OpenCode paths, not the mirror, so they're
      // worth showing even before the first sync — a user hitting the size
      // limit on their very first push deserves the same answer as anyone else.
      lines.push(await this.oversizedFileSummary());
      return lines.join('\n');
    }

    const head = await this.git(['log', '-1', '--format=%H %cI %s'], { allowFailure: true });
    lines.push(`HEAD commit: ${head.code === 0 && head.stdout.trim() ? head.stdout.trim() : '(no commits yet)'}`);

    const dbRepoPath = 'data/opencode.db';
    const dbLog = await this.git(['log', '-1', '--format=%cI  %s', '--', dbRepoPath], { allowFailure: true });
    lines.push(
      `Last commit touching ${dbRepoPath}: ${dbLog.stdout.trim() || '(never committed — either includeSecrets/privateRepoAcknowledged is off, or every sync so far skipped it)'}`
    );

    const lastPullAt = await this.readLastPullAt();
    lines.push(
      `Last successful pull completed on this machine: ${lastPullAt ? new Date(lastPullAt).toISOString() : '(never)'}`
    );

    // The question a "16 ahead" badge raises and can't answer: are those
    // commits stuck, and why? An ahead count alone reads as normal, so this
    // spells out the consequence and probes the remote for the actual git
    // error — which is otherwise only visible in a failed sync's message.
    const ahead = await this.git(['rev-list', '--count', `origin/${this.settings.branch}..HEAD`], {
      allowFailure: true,
    });
    const aheadCount = Number(ahead.stdout.trim());
    if (ahead.code === 0 && Number.isFinite(aheadCount) && aheadCount > 0) {
      lines.push(
        `Unpushed commits: ${aheadCount} — these are committed locally but NOT on GitHub. ` +
          'Everything in them is still only on this machine.'
      );
      const unpushedFiles = await this.git(
        ['diff', '--stat', `origin/${this.settings.branch}..HEAD`],
        { allowFailure: true }
      );
      const summary = unpushedFiles.stdout.trim().split('\n').slice(-1)[0];
      if (summary) {
        lines.push(`  Unpushed changes: ${summary.trim()}`);
      }
    } else if (ahead.code === 0) {
      lines.push('Unpushed commits: none — everything committed here is on GitHub.');
    }

    // A live reachability/auth check against the real remote. This is the
    // one thing that distinguishes "the remote is fine, nothing to send"
    // from "every push has been failing", and it reports git's own error
    // text rather than a paraphrase.
    if (this.settings.remoteUrl) {
      const probe = await this.git(['ls-remote', '--heads', 'origin', this.settings.branch], {
        allowFailure: true,
      });
      if (probe.code === 0) {
        lines.push(
          `Remote reachable: yes${probe.stdout.trim() ? '' : ` (branch "${this.settings.branch}" does not exist there yet)`}`
        );
      } else {
        lines.push(
          `Remote reachable: NO — ${probe.stderr.trim() || `git ls-remote exited with code ${probe.code}`}`
        );
        lines.push(
          '  Every push is failing for this reason. Nothing reaches GitHub until it is fixed — check the ' +
            'remote URL above, your network, and whether your stored GitHub credentials are still valid.'
        );
      }
    }

    const lockPath = path.join(this.repoDir, '.git', 'index.lock');
    const lockStat = await statOrNull(lockPath);
    if (lockStat) {
      const ageMs = Date.now() - lockStat.mtimeMs;
      const stale = ageMs >= STALE_INDEX_LOCK_AGE_MS;
      lines.push(
        `index.lock: PRESENT, ${Math.round(ageMs / 1000)}s old — ${
          stale
            ? 'stale (older than the auto-clear threshold; the next sync attempt removes it automatically).'
            : 'recent enough that it might be a real sync in progress right now. If every sync has failed with a lock error for longer than this, close VS Code, confirm no git process is running for this repo, then delete this file by hand.'
        }`
      );
    } else {
      lines.push('index.lock: absent.');
    }

    lines.push(await this.oversizedFileSummary());

    return lines.join('\n');
  }

  /**
   * Flags any file this tool is configured to sync that's already over the
   * skip threshold, independent of whether a sync has actually run recently
   * — so this shows up in the debug report even right after opening OpenCode
   * for the first time, before ever clicking Push.
   */
  private async oversizedFileSummary(): Promise<string> {
    const limitMb = OVERSIZED_FILE_SKIP_BYTES / (1024 * 1024);
    const { items } = await this.effectivePlan();
    const oversized: string[] = [];
    for (const item of items) {
      if (item.type !== 'file') {
        continue;
      }
      const stat = await statOrNull(item.localPath);
      if (stat && stat.size > OVERSIZED_FILE_SKIP_BYTES) {
        oversized.push(`${item.repoPath}: ${(stat.size / (1024 * 1024)).toFixed(0)} MB`);
      }
    }
    if (oversized.length === 0) {
      return `Oversized files (> ${limitMb} MB, skipped by every sync): none.`;
    }
    return `Oversized files (> ${limitMb} MB, skipped by every sync):\n  ${oversized.join('\n  ')}`;
  }

  // --------------------------------------------------------------- mirror ---

  private async mirrorToRepo(items: SyncItem[]): Promise<{ messages: string[]; databaseSkipped: boolean }> {
    const messages: string[] = [];
    let databaseSkipped = false;

    for (const item of items) {
      const destination = path.join(this.repoDir, ...item.repoPath.split('/'));
      if (!(await exists(item.localPath))) {
        continue;
      }

      if (item.type === 'file') {
        if (await this.isVolatile(item.localPath)) {
          if (item.repoPath === SESSION_DB_REPO_PATH) {
            databaseSkipped = true;
          }
          messages.push(
            `Skipped ${path.basename(item.localPath)}: uncheckpointed SQLite writes (-wal) are present. Close OpenCode and sync again.`
          );
          continue;
        }

        const oversized = await this.checkOversizedFile(item.localPath);
        if (oversized) {
          if (item.repoPath === SESSION_DB_REPO_PATH) {
            databaseSkipped = true;
          }
          messages.push(oversized);
          continue;
        }

        // The mirror's copy of opencode.db may already hold a same-push merge
        // resolution (see tryAutoResolveDatabaseConflict), or rows from a
        // machine this one hasn't pulled from yet. A plain overwrite here
        // would silently discard those rows; merging the local file's rows
        // into the existing mirror instead keeps both.
        if (item.repoPath === SESSION_DB_REPO_PATH && (await exists(destination))) {
          if (mergeSessionDatabases(destination, item.localPath) !== null) {
            continue;
          }
          // node:sqlite unavailable or either file unreadable: fall through
          // to the old overwrite behavior rather than skipping the sync.
        }

        const failure = await this.copyFile(item.localPath, destination, item.isSecret);
        if (failure) {
          messages.push(failure);
        }
        continue;
      }

      // Session directories merge instead of mirroring: pruning repo files that
      // are merely absent here would wipe the other machine's sessions.
      messages.push(...(await this.copyTree(item.localPath, destination, item.isSecret, !item.isSecret)));
    }

    return { messages, databaseSkipped };
  }

  private async applyFromRepo(items: SyncItem[]): Promise<{ count: number; messages: string[] }> {
    const messages: string[] = [];
    let count = 0;
    // `git checkout`/`merge` stamps every file in the mirror with "now", so
    // comparing against the mirror's own mtime would almost never protect a
    // real local edit (it's nearly always older than "the instant we just
    // fetched"). Comparing against when THIS machine last completed a pull
    // instead is the actual "has this been touched since I last synced?"
    // check the local-edit protection needs.
    const lastPullAt = await this.readLastPullAt();

    for (const item of items) {
      const source = path.join(this.repoDir, ...item.repoPath.split('/'));
      if (!(await exists(source))) {
        continue;
      }

      // opencode.db gets merged rather than mtime-gated like other files: the
      // mtime guard exists to protect a local edit made since the last pull,
      // but during an active session the database is touched constantly, so
      // that guard would block every incoming session forever. A merge can't
      // "clobber" a local row — it only adds rows or replaces one with a
      // strictly newer version of itself — so the guard's protection isn't
      // needed here in the first place.
      if (item.type === 'file' && item.repoPath === SESSION_DB_REPO_PATH && (await exists(item.localPath))) {
        const merged = mergeSessionDatabases(item.localPath, source);
        if (merged !== null) {
          count += merged > 0 ? 1 : 0;
          continue;
        }
        // node:sqlite unavailable or a file unreadable: fall through to the
        // old mtime-gated overwrite rather than skipping the sync entirely.
      }

      count +=
        item.type === 'file'
          ? (await this.applyFile(source, item.localPath, lastPullAt))
            ? 1
            : 0
          : await this.applyTree(source, item.localPath, lastPullAt);
    }

    // Some filesystems (overlay/network mounts common in containers and CI)
    // only report mtime to 1-second resolution, truncating rather than
    // rounding. A local write landing a few ms after this marker could then
    // be reported with an mtime that reads as *before* it. Backdating the
    // marker gives that truncation room to land on the safe side, at the
    // negligible cost of also protecting a local edit made just before this
    // pull — never the reverse.
    await this.writeLastPullAt(Date.now() - MTIME_SAFETY_MARGIN_MS);

    if (count > 0) {
      messages.push('Restart OpenCode so it reloads the pulled state.');
    }
    return { count, messages };
  }

  /**
   * Never overwrite a local file that was edited since our last successful
   * pull — that is what keeps the machine you are actively working on from
   * being rolled back by a stale sync from the other one. `lastPullAt === 0`
   * means this machine has never pulled before (e.g. `/sync-link` onto a
   * fresh machine), where adopting the remote's content unconditionally is
   * the whole point, so the guard is skipped only in that case.
   */
  private async applyFile(source: string, destination: string, lastPullAt: number): Promise<boolean> {
    try {
      const destStat = await statOrNull(destination);
      if (destStat) {
        const [sourceBuf, destBuf] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
        if (sourceBuf.equals(destBuf)) {
          return false;
        }
        // >= rather than >: filesystem mtimes and Date.now() can both land on
        // the same millisecond when an edit follows a pull almost instantly,
        // and a tie should fail safe (protect the local edit), not clobber it.
        if (lastPullAt > 0 && destStat.mtimeMs >= lastPullAt) {
          return false;
        }
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      // Same transient-lock tolerance as the push-side copy: overwriting a
      // live opencode.db while OpenCode still has it open can hit the same
      // brief Windows sharing violation. Falls through to the outer catch
      // (returns false, i.e. "nothing applied this round") once retries
      // are exhausted, rather than crashing the whole pull.
      const delays = [0, 150, 400];
      for (let i = 0; i < delays.length; i++) {
        if (delays[i] > 0) {
          await new Promise((resolve) => setTimeout(resolve, delays[i]));
        }
        try {
          await fs.copyFile(source, destination);
          return true;
        } catch (err) {
          if (i === delays.length - 1) {
            throw err;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private async applyTree(sourceDir: string, destinationDir: string, lastPullAt: number): Promise<number> {
    let count = 0;
    for (const entry of await readDirEntries(sourceDir)) {
      const source = path.join(sourceDir, entry.name);
      const destination = path.join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        count += await this.applyTree(source, destination, lastPullAt);
      } else if (await this.applyFile(source, destination, lastPullAt)) {
        count += 1;
      }
    }
    return count;
  }

  /** Local-only bookkeeping under `.git/`, so it's never staged, committed, or synced. */
  private stateFilePath(): string {
    return path.join(this.repoDir, '.git', 'opencode-session-hub-state.json');
  }

  private async readLastPullAt(): Promise<number> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFilePath(), 'utf8'));
      return typeof parsed.lastPullAt === 'number' ? parsed.lastPullAt : 0;
    } catch {
      return 0;
    }
  }

  private async writeLastPullAt(at: number): Promise<void> {
    try {
      await fs.writeFile(this.stateFilePath(), JSON.stringify({ lastPullAt: at }), 'utf8');
    } catch {
      // Best-effort bookkeeping; losing it just means the next pull falls
      // back to unconditional apply, not a sync failure.
    }
  }

  /**
   * A file OpenCode has open can hit a transient sharing violation on
   * Windows even when nothing is logically wrong — SQLite briefly holding
   * an exclusive handle mid-operation, antivirus scanning it, etc. A short
   * retry absorbs that; failing after retries returns a message instead of
   * throwing, so one locked file degrades to a skip rather than aborting
   * the entire sync (which is what used to happen: a single copyfile error
   * surfaced as a hard sync failure with nothing else touched).
   */
  private async copyFile(source: string, destination: string, isSecret: boolean): Promise<string | undefined> {
    await fs.mkdir(path.dirname(destination), { recursive: true });

    let mcpSecretsRedacted = 0;
    const attempt = async () => {
      // Redaction only ever touches session artifacts. Rewriting a config
      // file would push a broken opencode.json the other machine applies.
      if (isSecret && this.settings.redactSecrets && source.endsWith('.json')) {
        await fs.writeFile(destination, sanitizeJsonFile(await fs.readFile(source, 'utf8')), 'utf8');
        return;
      }

      // opencode.json/opencode.jsonc sync unconditionally (they're not
      // gated behind includeSecrets) but can hold real MCP server
      // credentials in mcp.*.headers/oauth — today those would otherwise
      // reach the sync repo in plaintext regardless of the secrets gate.
      // Unlike the blanket redaction above, this only swaps known
      // credential fields for OpenCode's own `{env:VAR}` placeholder
      // syntax — valid, meaningful JSON, not lossy — so the file this
      // writes is still one OpenCode can load (once the matching env var
      // is set), it just never puts the raw value in git history.
      const baseName = path.basename(source);
      if (baseName === 'opencode.json' || baseName === 'opencode.jsonc') {
        const sanitizedResult = sanitizeMcpSecretsInConfigText(await fs.readFile(source, 'utf8'));
        if (sanitizedResult) {
          mcpSecretsRedacted = sanitizedResult.redactedCount;
          await fs.writeFile(destination, sanitizedResult.content, 'utf8');
          return;
        }
        // Not parseable as plain JSON (e.g. .jsonc with comments) — fall
        // through to a plain copy rather than risk corrupting it.
      }

      await fs.copyFile(source, destination);
    };

    const delays = [0, 150, 400];
    let lastError: unknown;
    for (const delay of delays) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        await attempt();
        return mcpSecretsRedacted > 0
          ? `Replaced ${mcpSecretsRedacted} MCP credential(s) in ${path.basename(source)} with {env:VAR} placeholders before committing.`
          : undefined;
      } catch (err) {
        lastError = err;
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    return `Skipped ${path.basename(source)}: locked by another process (${reason}). Will retry on the next sync.`;
  }

  private async copyTree(
    sourceDir: string,
    destinationDir: string,
    isSecret: boolean,
    prune: boolean
  ): Promise<string[]> {
    await fs.mkdir(destinationDir, { recursive: true });
    const seen = new Set<string>();
    const messages: string[] = [];

    for (const entry of await readDirEntries(sourceDir)) {
      if (isVolatileName(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      const source = path.join(sourceDir, entry.name);
      const destination = path.join(destinationDir, entry.name);

      if (entry.isDirectory()) {
        messages.push(...(await this.copyTree(source, destination, isSecret, prune)));
      } else if (entry.isFile()) {
        const failure = await this.copyFile(source, destination, isSecret);
        if (failure) {
          messages.push(failure);
        }
      }
    }

    if (!prune) {
      return messages;
    }
    for (const entry of await readDirEntries(destinationDir)) {
      if (!seen.has(entry.name)) {
        await fs.rm(path.join(destinationDir, entry.name), { recursive: true, force: true });
      }
    }
    return messages;
  }

  /**
   * A non-empty -wal beside the database means SQLite has content that
   * hasn't been merged into the main file yet. SQLite's WAL mode means that
   * during an active OpenCode session the WAL is *continuously* non-empty —
   * OpenCode only checkpoints it back into the main file on a clean exit —
   * so treating "WAL file exists" alone as the signal would skip
   * opencode.db on essentially every sync while actively using it, even
   * though "Synced" is what the panel would still report (nothing else
   * changed to commit).
   *
   * A PASSIVE checkpoint is the fix, but its own success has to be judged
   * from what it reports back (`busy`/`checkpointed`/`log`), not from the
   * WAL file's size afterward — PASSIVE merges committed frames into the
   * main file but does not necessarily shrink the WAL file itself (only
   * TRUNCATE mode does, and that can block). Once every frame is
   * checkpointed and nothing was busy, the main .db file alone is already
   * a complete, consistent snapshot; a leftover WAL file at that point is
   * just reusable space SQLite hasn't cleared yet, not missing data.
   */
  /**
   * See OVERSIZED_FILE_SKIP_BYTES: a file this large is either going to be
   * rejected by GitHub outright or spend real time/disk being hashed and
   * compressed by git first. Skipping it here means the sync repo and the
   * user's bandwidth never pay that cost, and the resulting message is the
   * direct, actionable answer to "why didn't this sync" instead of a lock
   * timeout or a push rejection with no obvious cause.
   */
  private async checkOversizedFile(filePath: string): Promise<string | undefined> {
    const stat = await statOrNull(filePath);
    if (!stat || stat.size <= OVERSIZED_FILE_SKIP_BYTES) {
      return undefined;
    }
    const actualMb = (stat.size / (1024 * 1024)).toFixed(0);
    const limitMb = OVERSIZED_FILE_SKIP_BYTES / (1024 * 1024);
    return (
      `Skipped ${path.basename(filePath)}: ${actualMb} MB exceeds the ${limitMb} MB sync limit ` +
      '(GitHub rejects any single file over 100 MB, and git would spend real time hashing it first). ' +
      'If this is opencode.db, sessions are still being synced individually one file per session, so your ' +
      'history does reach the remote — but to sync the database as a whole again, close OpenCode and run ' +
      '"Compact Database…" from the sidebar (or "OpenCode Sync: Compact Database (VACUUM)") to shrink it.'
    );
  }

  private async isVolatile(filePath: string): Promise<boolean> {
    if (isVolatileName(filePath)) {
      return true;
    }
    if (!filePath.endsWith('.db')) {
      return false;
    }

    const wal = await statOrNull(`${filePath}-wal`);
    if (!wal || wal.size === 0) {
      return false;
    }

    return !(await tryCheckpointDatabase(filePath));
  }

  /**
   * `git add -A` can transiently fail with "confused by unstable object
   * source data" — git detects a working-tree file's size changing mid-hash
   * and refuses to trust it, rather than commit something possibly
   * inconsistent.
   *
   * This was originally attributed to antivirus or OneDrive touching the
   * file mid-hash, on the assumption that nothing of ours could be the
   * other writer. That assumption was wrong. A later log from the same
   * machine showed `git add -A` failing with
   * `open("…/<id>.db.tmp-900-…"): No such file or directory` — git was
   * indexing OUR export scratch file, which OUR code deleted from under it.
   * Those scratch files were being written inside the repo (fixed: they go
   * to the OS temp directory now), and two VS Code windows sharing one
   * mirror directory could run git and an export against it at the same
   * time (fixed: withRepoLock below). Between them, those account for the
   * failures actually observed.
   *
   * The retry stays as a genuine last resort — a real external scanner can
   * still produce this, and waiting a few seconds costs nothing next to
   * failing the sync — but it is no longer the explanation.
   */
  private async gitAddAllWithRetry(): Promise<void> {
    const delays = [0, 300, 800, 1500, 3000, 4000, 5000];
    let lastError: unknown;
    for (const delay of delays) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        await this.git(['add', '-A']);
        return;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!/confused by unstable object source data/i.test(message)) {
          throw err; // A different failure — surface it immediately, don't mask it behind retries.
        }
      }
    }
    throw lastError instanceof SyncError ? lastError : new SyncError(String(lastError));
  }

  private git(args: string[], options: { allowFailure?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.repoDir });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', (err) => reject(new SyncError(`Could not run git: ${err.message}`)));
      child.on('close', (code) => {
        const result: GitResult = { code: code ?? 1, stdout, stderr };
        if (result.code !== 0 && !options.allowFailure) {
          reject(new SyncError(`git ${args.join(' ')} failed: ${stderr.trim() || stdout.trim()}`));
          return;
        }
        resolve(result);
      });
    });
  }
}

const CONFLICT_HINT = 'The sync repository has conflicting changes. Run "OpenCode Sync: Resolve Conflicts".';

/** Covers common 1-second mtime truncation on overlay/network filesystems. */
const MTIME_SAFETY_MARGIN_MS = 2000;

/**
 * GitHub hard-rejects any single file over 100 MiB on push, and `git add`
 * fully re-hashes and re-compresses a changed binary file on every commit
 * (no binary diffing), so a multi-GB opencode.db doesn't just fail to push —
 * it can spend minutes doing that work locally first, on every sync attempt.
 * Skipping well under the hard limit avoids both: the wasted local work and
 * a push that was always going to be rejected.
 */
const OVERSIZED_FILE_SKIP_BYTES = 90 * 1024 * 1024;

/**
 * Target size when an event-format session export overshoots the skip
 * limit: oldest message/part events are dropped newest-first until the file
 * fits under this. Deliberately a hair under OVERSIZED_FILE_SKIP_BYTES so
 * the truncated file always passes the check above on every filesystem.
 */
const TRUNCATED_SESSION_BUDGET_BYTES = 89 * 1024 * 1024;

/** Where per-session favorite exports live in the mirror, one file per session id — see mirrorFavoriteSessions/applyFavoriteSessions. */
const FAVORITE_SESSIONS_REPO_DIR = 'data/favorite-sessions';

/**
 * Cap on how many sessions one push exports individually when the whole
 * database can't sync. High enough to cover a real machine's working set
 * (the reported one has ~150), bounded so a machine with thousands of
 * sessions doesn't turn every push into thousands of SQLite exports.
 * Favorites are always exported and never counted against this.
 */
const MAX_INDIVIDUAL_SESSION_EXPORTS = 200;

/**
 * How long a repo lock can sit unrefreshed before another window treats its
 * holder as gone. Generous relative to the heartbeat below, so only a
 * genuinely dead holder is ever taken over.
 */
const REPO_LOCK_STALE_MS = 2 * 60 * 1000;

/** How often the lock holder refreshes its lock while it works. */
const REPO_LOCK_HEARTBEAT_MS = 10 * 1000;

/** Bounds inspectOversizedUnpushedHistory's scan so a very long unpushed history can't turn every push into a slow full scan. */
const MAX_HISTORY_SCAN_COMMITS = 100;

/**
 * How long a `.git/index.lock` has to sit untouched before it's treated as
 * stale rather than a real concurrent operation. Plain `git` doesn't record
 * which process holds this lock (unlike opencode-synced's own PID-tagged
 * lock file), so age is the only signal available — but the
 * OVERSIZED_FILE_SKIP_BYTES guard above means no operation this tool runs
 * should legitimately hold it for anywhere near this long, so it's safe to
 * break. A lock left behind by a crashed VS Code process or a killed git
 * child otherwise never clears itself, permanently blocking every sync.
 */
const STALE_INDEX_LOCK_AGE_MS = 2 * 60 * 1000;

/**
 * True only for the one benign `git fetch` failure: the remote exists and is
 * reachable, but has no such branch yet (a repository created empty, before
 * anything was ever pushed to it). Every other failure — bad credentials, no
 * network, wrong URL, DNS — means nothing was fetched and must not be
 * mistaken for an empty remote.
 */
function isMissingRemoteBranch(stderr: string): boolean {
  return /couldn't find remote ref|couldn't find remote branch|no such ref was fetched/i.test(stderr);
}

function isVolatileName(name: string): boolean {
  return VOLATILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Best-effort, non-blocking WAL checkpoint. PASSIVE never waits for or
 * interrupts a concurrent writer — at worst it checkpoints zero frames if
 * OpenCode is writing at that exact instant, which is safe and exactly what
 * "best-effort" means here. Returns whether every frame actually got
 * checkpointed (`busy = 0` and `checkpointed === log`), which is the only
 * way to know the main .db file is a complete, consistent snapshot on its
 * own — WAL file *size* doesn't tell you that, since PASSIVE doesn't shrink
 * it. Returns false without throwing on Node < 22.5 (no node:sqlite) or if
 * the file can't be opened for any other reason; the caller then falls back
 * to skipping, same as before this existed.
 */
async function tryCheckpointDatabase(databasePath: string): Promise<boolean> {
  let DatabaseSync: new (
    p: string,
    o?: Record<string, unknown>
  ) => { prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return false;
  }

  try {
    const db = new DatabaseSync(databasePath);
    try {
      const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE);').get();
      if (!row) {
        return false;
      }
      const busy = Number(row.busy);
      const log = Number(row.log);
      const checkpointed = Number(row.checkpointed);
      return busy === 0 && Number.isFinite(log) && checkpointed === log;
    } finally {
      db.close();
    }
  } catch {
    // A concurrent writer holding a lock, or any other reason the
    // checkpoint attempt failed — treat it as not fully checkpointed.
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  return (await statOrNull(target)) !== null;
}

async function readFileOrNull(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function statOrNull(target: string) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function readDirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Reads an export file's table list without fully opening it for merge.
 * Without node:sqlite (or on an unreadable file) this answers true, which
 * preserves the old bootstrap behavior instead of stranding a fresh machine.
 */
function exportFileHasTable(dbPath: string, table: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
        n: number;
      };
      return Number(row?.n ?? 0) > 0;
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    return true;
  }
}
