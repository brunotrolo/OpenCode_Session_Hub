import { spawn } from 'child_process';
import { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { buildSyncPlan, OpenCodeLocations, SyncItem } from './opencodePaths';
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
  private async fetchAndIntegrate(): Promise<{ conflicted: boolean }> {
    const fetch = await this.git(['fetch', 'origin', this.settings.branch], { allowFailure: true });
    if (fetch.code !== 0) {
      // A freshly created empty remote has no branch yet; not an error.
      return { conflicted: false };
    }

    if ((await this.git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).code !== 0) {
      await this.git(['checkout', '-B', this.settings.branch, `origin/${this.settings.branch}`]);
      return { conflicted: false };
    }

    const merge = await this.git(['merge', '--no-edit', `origin/${this.settings.branch}`], { allowFailure: true });
    return { conflicted: merge.code !== 0 };
  }

  async push(): Promise<SyncOutcome> {
    await this.ensureRepo();
    const { items, messages } = this.effectivePlan();

    if ((await this.fetchAndIntegrate()).conflicted) {
      return { status: 'conflict', messages: [...messages, CONFLICT_HINT], changedFiles: 0 };
    }

    messages.push(...(await this.mirrorToRepo(items)));

    await this.git(['add', '-A']);
    const staged = (await this.git(['diff', '--cached', '--name-only'])).stdout.trim();
    if (!staged) {
      return { status: 'no-changes', messages, changedFiles: 0 };
    }

    await this.git(['commit', '-m', `sync: ${new Date().toISOString()}`]);
    await this.git(['push', '-u', 'origin', this.settings.branch]);

    return { status: 'ok', messages, changedFiles: staged.split('\n').length };
  }

  /**
   * Pulls the sync repo AND applies it to the local OpenCode directories.
   * Without the apply step, arriving at the other machine downloads nothing
   * OpenCode can actually read.
   */
  async pull(): Promise<SyncOutcome> {
    await this.ensureRepo();
    const { items, messages } = this.effectivePlan();

    if ((await this.fetchAndIntegrate()).conflicted) {
      return { status: 'conflict', messages: [...messages, CONFLICT_HINT], changedFiles: 0 };
    }

    const applied = await this.applyFromRepo(items);
    messages.push(...applied.messages);
    return { status: applied.count > 0 ? 'ok' : 'no-changes', messages, changedFiles: applied.count };
  }

  /** Resolves a conflicted merge by taking one side wholesale. */
  async resolveConflicts(keep: 'local' | 'remote'): Promise<SyncOutcome> {
    await this.ensureRepo();
    const conflicted = (await this.git(['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (conflicted.length === 0) {
      await this.git(['merge', '--abort'], { allowFailure: true });
      return { status: 'no-changes', messages: ['No conflicted files to resolve.'], changedFiles: 0 };
    }

    // During a merge, --ours is this machine's mirror and --theirs is the remote.
    const strategy = keep === 'local' ? '--ours' : '--theirs';
    for (const file of conflicted) {
      await this.git(['checkout', strategy, '--', file], { allowFailure: true });
      await this.git(['add', '--', file], { allowFailure: true });
    }
    await this.git(['commit', '--no-edit'], { allowFailure: true });

    return {
      status: 'ok',
      messages: [`Resolved ${conflicted.length} conflicted file(s), keeping the ${keep} version.`],
      changedFiles: conflicted.length,
    };
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
        await this.copyFile(item.localPath, destination, item.isSecret);
        continue;
      }

      // Session directories merge instead of mirroring: pruning repo files that
      // are merely absent here would wipe the other machine's sessions.
      await this.copyTree(item.localPath, destination, item.isSecret, !item.isSecret);
    }

    return messages;
  }

  private async applyFromRepo(items: SyncItem[]): Promise<{ count: number; messages: string[] }> {
    const messages: string[] = [];
    let count = 0;

    for (const item of items) {
      const source = path.join(this.repoDir, ...item.repoPath.split('/'));
      if (!(await exists(source))) {
        continue;
      }
      count += item.type === 'file' ? ((await this.applyFile(source, item.localPath)) ? 1 : 0) : await this.applyTree(source, item.localPath);
    }

    if (count > 0) {
      messages.push('Restart OpenCode so it reloads the pulled state.');
    }
    return { count, messages };
  }

  /**
   * Never overwrite a local file that is newer than the synced copy. That is
   * what keeps the machine you are actively working on from being rolled back
   * by a stale push from the other one.
   */
  private async applyFile(source: string, destination: string): Promise<boolean> {
    try {
      const sourceStat = await fs.stat(source);
      const destStat = await statOrNull(destination);
      if (destStat) {
        if (destStat.mtimeMs > sourceStat.mtimeMs) {
          return false;
        }
        const [a, b] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
        if (a.equals(b)) {
          return false;
        }
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
      return true;
    } catch {
      return false;
    }
  }

  private async applyTree(sourceDir: string, destinationDir: string): Promise<number> {
    let count = 0;
    for (const entry of await readDirEntries(sourceDir)) {
      const source = path.join(sourceDir, entry.name);
      const destination = path.join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        count += await this.applyTree(source, destination);
      } else if (await this.applyFile(source, destination)) {
        count += 1;
      }
    }
    return count;
  }

  private async copyFile(source: string, destination: string, isSecret: boolean): Promise<void> {
    await fs.mkdir(path.dirname(destination), { recursive: true });

    // Redaction only ever touches session artifacts. Rewriting a config file
    // would push a broken opencode.json that the other machine then applies.
    if (isSecret && this.settings.redactSecrets && source.endsWith('.json')) {
      await fs.writeFile(destination, sanitizeJsonFile(await fs.readFile(source, 'utf8')), 'utf8');
      return;
    }
    await fs.copyFile(source, destination);
  }

  private async copyTree(sourceDir: string, destinationDir: string, isSecret: boolean, prune: boolean): Promise<void> {
    await fs.mkdir(destinationDir, { recursive: true });
    const seen = new Set<string>();

    for (const entry of await readDirEntries(sourceDir)) {
      if (isVolatileName(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      const source = path.join(sourceDir, entry.name);
      const destination = path.join(destinationDir, entry.name);

      if (entry.isDirectory()) {
        await this.copyTree(source, destination, isSecret, prune);
      } else if (entry.isFile()) {
        await this.copyFile(source, destination, isSecret);
      }
    }

    if (!prune) {
      return;
    }
    for (const entry of await readDirEntries(destinationDir)) {
      if (!seen.has(entry.name)) {
        await fs.rm(path.join(destinationDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  /** A database with a non-empty -wal beside it has uncheckpointed writes. */
  private async isVolatile(filePath: string): Promise<boolean> {
    if (isVolatileName(filePath)) {
      return true;
    }
    if (!filePath.endsWith('.db')) {
      return false;
    }
    const wal = await statOrNull(`${filePath}-wal`);
    return wal !== null && wal.size > 0;
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

function isVolatileName(name: string): boolean {
  return VOLATILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
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
