import * as path from 'path';
import * as vscode from 'vscode';
import { buildDebugReport } from './debugInfo';
import { vacuumDatabase, VacuumResult } from './dbMaintenance';
import { addFavorite, FavoriteSession, loadFavorites, removeFavorite, removeFavoritesBySessionId } from './favorites';
import { OpenCodeLocations, resolveOpenCodeLocations } from './opencodePaths';
import { DirectoryMapping } from './pathMapper';
import { deleteSession, scanSessions, SessionRecord } from './sessionScanner';
import { SyncError, SyncManager, SyncOutcome, SyncRepoStatus, SyncSettings, SyncStatus } from './syncManager';

export interface ControllerState {
  status: SyncStatus;
  direction?: 'push' | 'pull';
  lastOutcome?: SyncOutcome;
  lastError?: string;
  lastSyncAt?: number;
  repoStatus?: SyncRepoStatus;
}

/**
 * Owns everything both the command palette and the sidebar dashboard need:
 * reading settings, running a sync, and the live status other UI pieces
 * (status bar, webview) subscribe to. Keeping this in one place means the
 * dashboard and the commands can never disagree about what "syncing" means.
 */
export class SyncController {
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<ControllerState>();
  readonly onDidChangeState = this.emitter.event;
  private state: ControllerState;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.state = { status: this.getSettings().remoteUrl ? 'idle' : 'unconfigured' };
  }

  getState(): ControllerState {
    return this.state;
  }

  private setState(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch };
    this.emitter.fire(this.state);
  }

  getLocations(): OpenCodeLocations {
    const override = vscode.workspace.getConfiguration('opencodeSessionHub').get<string>('dataPath', '').trim();
    return resolveOpenCodeLocations(process.env, process.platform, override || undefined);
  }

  getSettings(): SyncSettings {
    const config = vscode.workspace.getConfiguration('opencodeSessionHub');
    const repoDir = config.get<string>('syncRepoPath', '').trim();

    return {
      remoteUrl: config.get<string>('syncRemoteUrl', '').trim(),
      branch: config.get<string>('syncBranch', 'main').trim() || 'main',
      repoDir: repoDir || path.join(this.context.globalStorageUri.fsPath, 'sync-repo'),
      includeSecrets: config.get<boolean>('includeSecrets', false),
      includeSessions: config.get<boolean>('includeSessions', true),
      includeModelFavorites: config.get<boolean>('includeModelFavorites', true),
      includeOpencodeSkills: config.get<boolean>('includeOpencodeSkills', true),
      includeAgentsDir: config.get<boolean>('includeAgentsDir', true),
      redactSecrets: config.get<boolean>('redactSecrets', true),
      privateRepoAcknowledged: config.get<boolean>('privateRepoAcknowledged', false),
    };
  }

  getMappings(): DirectoryMapping[] {
    const raw = vscode.workspace
      .getConfiguration('opencodeSessionHub')
      .get<DirectoryMapping[]>('directoryMappings', []);
    return raw.filter((entry) => entry && typeof entry.from === 'string' && typeof entry.to === 'string');
  }

  listSessions(): { sessions: SessionRecord[]; warnings: string[] } {
    return scanSessions(this.getLocations());
  }

  listFavorites(): FavoriteSession[] {
    return loadFavorites(this.getLocations());
  }

  /**
   * Favorites live in a config file the sync plan already mirrors, so
   * adding one is picked up by the very next push/pull with no dedicated
   * sync logic — the only thing this needs to do is write the file.
   */
  addFavorite(label: string, sessionId: string): FavoriteSession {
    return addFavorite(this.getLocations(), label, sessionId);
  }

  removeFavorite(id: string): void {
    removeFavorite(this.getLocations(), id);
  }

  /**
   * Deletes a session's own files from this machine's storage and drops any
   * favorite bookmarking it. Local-only: the sync repo and any other
   * machine's copy are unaffected (see deleteSession()'s own note on why).
   */
  deleteSession(record: SessionRecord): void {
    const locations = this.getLocations();
    deleteSession(locations, record);
    removeFavoritesBySessionId(locations, record.id);
  }

  async updateSetting(key: string, value: unknown): Promise<void> {
    if (key === 'syncRemoteUrl' && typeof value === 'string') {
      value = dedupeIfSelfConcatenated(value);
    }
    await vscode.workspace.getConfiguration('opencodeSessionHub').update(key, value, vscode.ConfigurationTarget.Global);
    // Settings like the remote URL flip unconfigured -> idle immediately,
    // so the dashboard doesn't need a manual refresh after Save.
    if (this.state.status === 'unconfigured' && this.getSettings().remoteUrl) {
      this.setState({ status: 'idle' });
    }
  }

  scheduleDebouncedPush(seconds: number): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.sync('push', { silent: true });
    }, Math.max(1, seconds) * 1000);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  private log(line: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${line}`);
  }

  /**
   * Serializes every operation that touches the sync repo's working
   * directory (push, pull, resolveConflicts, status) through one queue.
   * Without this, a debounced auto-push firing while a manual push is
   * still running (or two rapid clicks) starts two SyncManager instances
   * against the exact same repoDir concurrently — one's `git add`/commit
   * can end up reading a file the other is still writing mid-mutation.
   * That's exactly how a real report got "git add -A failed: fatal:
   * confused by unstable object source data": git detected a file's
   * content change while it was still hashing it. Queueing costs nothing
   * in the common case (nothing else is ever running) and just makes a
   * second call wait its turn instead of racing the first.
   */
  private syncQueue: Promise<void> = Promise.resolve();

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.syncQueue.then(task, task);
    this.syncQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async sync(direction: 'push' | 'pull', options: { silent?: boolean } = {}): Promise<SyncOutcome | undefined> {
    return this.enqueue(() => this.syncNow(direction, options));
  }

  private async syncNow(direction: 'push' | 'pull', options: { silent?: boolean } = {}): Promise<SyncOutcome | undefined> {
    const settings = this.getSettings();
    if (!settings.remoteUrl) {
      this.setState({ status: 'unconfigured' });
      if (!options.silent) {
        vscode.window.showWarningMessage(
          'Set a sync repository URL first (Session Hub sidebar, or "OpenCode Sync: Initialize Sync Repository").'
        );
      }
      return undefined;
    }

    this.setState({ status: 'syncing', direction });
    const manager = new SyncManager(this.getLocations(), settings);

    try {
      const outcome = await (direction === 'push' ? manager.push() : manager.pull());
      for (const message of outcome.messages) {
        this.log(message);
      }
      this.setState({
        status: outcome.status === 'conflict' ? 'conflict' : 'idle',
        lastOutcome: outcome,
        lastSyncAt: Date.now(),
        lastError: undefined,
      });
      return outcome;
    } catch (err) {
      const message = err instanceof SyncError ? err.message : String(err);
      this.log(`${direction} failed: ${message}`);
      this.setState({ status: 'error', lastError: message });
      throw err;
    }
  }

  async initOrLink(url: string, mode: 'init' | 'link'): Promise<SyncOutcome | undefined> {
    await this.updateSetting('syncRemoteUrl', url.trim());
    // Linking adopts the remote's state; initializing publishes this machine's.
    return this.sync(mode === 'link' ? 'pull' : 'push');
  }

  async refreshStatus(): Promise<SyncRepoStatus | undefined> {
    return this.enqueue(() => this.refreshStatusNow());
  }

  private async refreshStatusNow(): Promise<SyncRepoStatus | undefined> {
    const settings = this.getSettings();
    if (!settings.remoteUrl) {
      this.setState({ status: 'unconfigured', repoStatus: undefined });
      return undefined;
    }
    try {
      const repoStatus = await new SyncManager(this.getLocations(), settings).status();
      this.setState({ status: repoStatus.conflicted ? 'conflict' : 'idle', repoStatus });
      return repoStatus;
    } catch (err) {
      const message = err instanceof SyncError ? err.message : String(err);
      this.log(`status check failed: ${message}`);
      this.setState({ status: 'error', lastError: message });
      return undefined;
    }
  }

  async resolveConflicts(keep: 'local' | 'remote'): Promise<SyncOutcome> {
    return this.enqueue(() => this.resolveConflictsNow(keep));
  }

  private async resolveConflictsNow(keep: 'local' | 'remote'): Promise<SyncOutcome> {
    const outcome = await new SyncManager(this.getLocations(), this.getSettings()).resolveConflicts(keep);
    this.setState({ status: 'idle', lastOutcome: outcome, lastSyncAt: Date.now() });
    return outcome;
  }

  async buildDebugReport(): Promise<string> {
    const locations = this.getLocations();
    const settings = this.getSettings();
    return buildDebugReport(locations, settings, new SyncManager(locations, settings));
  }

  /**
   * Shrinks opencode.db via VACUUM — the fix for a database that's grown
   * large enough to be skipped by the sync size limit (see
   * OVERSIZED_FILE_SKIP_BYTES in syncManager.ts). Local-only: it doesn't
   * touch the sync repo, so a sync still needs to run afterward to actually
   * publish the smaller database.
   */
  async compactDatabase(): Promise<VacuumResult> {
    return vacuumDatabase(this.getLocations().databasePath);
  }
}

/**
 * Catches the exact real-world failure of pasting a URL into the Remote URL
 * field when it already contained the same value, producing something like
 * "https://github.com/x/yhttps://github.com/x/y" — a string with no
 * separator, so it looks nothing like a valid git URL and every fetch/push
 * fails against it (indefinitely, if git ends up retrying or waiting on a
 * credential prompt for a host that can't resolve), which reads as "stuck
 * syncing forever" rather than a clear error naming the bad URL. Detected by
 * splitting the trimmed string exactly in half and checking both halves are
 * identical — deliberately narrow (an accidental exact self-paste) rather
 * than a general URL validator, so it can never reject a URL that's simply
 * unusual without also being sure it's this specific mistake.
 */
function dedupeIfSelfConcatenated(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length % 2 !== 0) {
    return trimmed;
  }
  const half = trimmed.length / 2;
  const first = trimmed.slice(0, half);
  const second = trimmed.slice(half);
  return first === second ? first : trimmed;
}
