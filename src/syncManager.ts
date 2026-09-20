import { spawn } from 'child_process';
import { Dirent, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { mergeSessionDatabases } from './dbMerge';
import { buildSyncPlan, OpenCodeLocations, SESSION_DB_REPO_PATH, SyncItem } from './opencodePaths';
import { sanitizeJsonFile } from './secretSanitizer';

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
  private effectivePlan(): { items: SyncItem[]; messages: string[] } {
    const messages: string[] = [];
    const secretsAllowed = this.settings.includeSecrets && this.settings.privateRepoAcknowledged;

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

    return { items, messages };
  }

  async ensureRepo(): Promise<void> {
    if (!this.settings.remoteUrl) {
      throw new SyncError('Set opencodeSessionHub.syncRemoteUrl before syncing.');
    }

    await fs.mkdir(this.repoDir, { recursive: true });

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
  }

  /** Fetches the remote branch and merges it into the local mirror. */
  private async fetchAndIntegrate(): Promise<{ conflicted: boolean; messages: string[] }> {
    const fetch = await this.git(['fetch', 'origin', this.settings.branch], { allowFailure: true });
    if (fetch.code !== 0) {
      // A freshly created empty remote has no branch yet; not an error.
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
    await this.ensureRepo();
    const { items, messages } = this.effectivePlan();

    const integration = await this.fetchAndIntegrate();
    messages.push(...integration.messages);
    if (integration.conflicted) {
      return { status: 'conflict', messages: [...messages, CONFLICT_HINT], changedFiles: 0 };
    }

    messages.push(...(await this.mirrorToRepo(items)));

    await this.git(['add', '-A']);
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

    await this.git(['push', '-u', 'origin', this.settings.branch]);

    return { status: 'ok', messages, changedFiles: staged ? staged.split('\n').length : 0 };
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
   * Pulls the sync repo AND applies it to the local OpenCode directories.
   * Without the apply step, arriving at the other machine downloads nothing
   * OpenCode can actually read.
   */
  async pull(): Promise<SyncOutcome> {
    await this.ensureRepo();
    const { items, messages } = this.effectivePlan();

    const integration = await this.fetchAndIntegrate();
    messages.push(...integration.messages);
    if (integration.conflicted) {
      return { status: 'conflict', messages: [...messages, CONFLICT_HINT], changedFiles: 0 };
    }

    const applied = await this.applyFromRepo(items);
    messages.push(...applied.messages);
    return { status: applied.count > 0 ? 'ok' : 'no-changes', messages, changedFiles: applied.count };
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

    const { items } = this.effectivePlan();
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

    return lines.join('\n');
  }

  // --------------------------------------------------------------- mirror ---

  private async mirrorToRepo(items: SyncItem[]): Promise<string[]> {
    const messages: string[] = [];

    for (const item of items) {
      const destination = path.join(this.repoDir, ...item.repoPath.split('/'));
      if (!(await exists(item.localPath))) {
        continue;
      }

      if (item.type === 'file') {
        if (await this.isVolatile(item.localPath)) {
          messages.push(
            `Skipped ${path.basename(item.localPath)}: uncheckpointed SQLite writes (-wal) are present. Close OpenCode and sync again.`
          );
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

    return messages;
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

    const attempt = async () => {
      // Redaction only ever touches session artifacts. Rewriting a config
      // file would push a broken opencode.json the other machine applies.
      if (isSecret && this.settings.redactSecrets && source.endsWith('.json')) {
        await fs.writeFile(destination, sanitizeJsonFile(await fs.readFile(source, 'utf8')), 'utf8');
        return;
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
        return undefined;
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
