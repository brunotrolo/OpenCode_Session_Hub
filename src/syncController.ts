import * as path from 'path';
import * as vscode from 'vscode';
import { buildDebugReport } from './debugInfo';
import { addFavorite, FavoriteSession, loadFavorites, removeFavorite } from './favorites';
import { OpenCodeLocations, resolveOpenCodeLocations } from './opencodePaths';
import { DirectoryMapping } from './pathMapper';
import { scanSessions, SessionRecord } from './sessionScanner';
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

  async updateSetting(key: string, value: unknown): Promise<void> {
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

  async sync(direction: 'push' | 'pull', options: { silent?: boolean } = {}): Promise<SyncOutcome | undefined> {
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
    const outcome = await new SyncManager(this.getLocations(), this.getSettings()).resolveConflicts(keep);
    this.setState({ status: 'idle', lastOutcome: outcome, lastSyncAt: Date.now() });
    return outcome;
  }

  async buildDebugReport(): Promise<string> {
    const locations = this.getLocations();
    const settings = this.getSettings();
    return buildDebugReport(locations, settings, new SyncManager(locations, settings));
  }
}
