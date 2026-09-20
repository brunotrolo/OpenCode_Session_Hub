import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getExtensionSyncRoot, getOpenCodeStorageRoot } from './storagePaths';
import { sanitizeJsonFile } from './secretSanitizer';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'unconfigured';

export class SyncManager {
  private debounceTimer: NodeJS.Timeout | undefined;
  private status: SyncStatus = 'idle';
  private readonly onStatusChange = new vscode.EventEmitter<SyncStatus>();
  readonly onDidChangeStatus = this.onStatusChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get syncRoot(): string {
    return getExtensionSyncRoot(this.context);
  }

  private get remoteUrl(): string {
    return vscode.workspace.getConfiguration('opencodeSessionHub').get<string>('syncRemoteUrl', '').trim();
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    this.onStatusChange.fire(status);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /** Schedules a push after `debounceSeconds` of inactivity, restarting the timer on every call. */
  scheduleDebouncedPush() {
    const seconds = vscode.workspace.getConfiguration('opencodeSessionHub').get<number>('debounceSeconds', 20);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.push().catch((err) => console.error('[OpenCode Session Hub] debounced push failed', err));
    }, Math.max(1, seconds) * 1000);
  }

  async initSyncRepo(): Promise<void> {
    const remote = this.remoteUrl;
    if (!remote) {
      throw new Error('Set opencodeSessionHub.syncRemoteUrl before initializing the sync repository.');
    }

    fs.mkdirSync(this.syncRoot, { recursive: true });

    if (!fs.existsSync(path.join(this.syncRoot, '.git'))) {
      await this.runGit(['init']);
      await this.runGit(['remote', 'add', 'origin', remote]);
    }

    // Best-effort: repo may not have an initial commit on the remote yet.
    try {
      await this.runGit(['fetch', 'origin']);
      await this.runGit(['checkout', '-B', 'main', 'origin/main']);
    } catch {
      await this.runGit(['checkout', '-B', 'main']);
    }
  }

  async push(): Promise<void> {
    if (!this.remoteUrl) {
      this.setStatus('unconfigured');
      return;
    }

    this.setStatus('syncing');
    try {
      await this.mirrorSanitizedSnapshot();
      await this.runGit(['add', '-A']);

      const hasChanges = await this.hasStagedChanges();
      if (!hasChanges) {
        this.setStatus('idle');
        return;
      }

      await this.runGit(['commit', '-m', `sync: ${new Date().toISOString()}`]);
      await this.runGit(['push', '-u', 'origin', 'main']);
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('error');
      throw err;
    }
  }

  async pull(): Promise<void> {
    if (!this.remoteUrl) {
      this.setStatus('unconfigured');
      return;
    }

    this.setStatus('syncing');
    try {
      fs.mkdirSync(this.syncRoot, { recursive: true });
      if (!fs.existsSync(path.join(this.syncRoot, '.git'))) {
        await this.initSyncRepo();
      }
      await this.runGit(['fetch', 'origin']);
      await this.runGit(['reset', '--hard', 'origin/main']);
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('error');
      throw err;
    }
  }

  /**
   * Copies session JSON from the live OpenCode storage into the sync repo,
   * redacting secrets along the way. Never writes sanitized data back over
   * the live OpenCode files.
   */
  private async mirrorSanitizedSnapshot(): Promise<void> {
    const storageRoot = getOpenCodeStorageRoot();
    const projectRoot = path.join(storageRoot, 'project');
    if (!fs.existsSync(projectRoot)) {
      return;
    }

    const redact = vscode.workspace.getConfiguration('opencodeSessionHub').get<boolean>('redactSecrets', true);
    const destRoot = path.join(this.syncRoot, 'project');
    fs.mkdirSync(destRoot, { recursive: true });

    copyJsonTreeSanitized(projectRoot, destRoot, redact);
  }

  private async hasStagedChanges(): Promise<boolean> {
    try {
      await this.runGit(['diff', '--cached', '--quiet']);
      return false; // exit code 0 == no diff
    } catch {
      return true; // non-zero exit == there is a diff
    }
  }

  private runGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.syncRoot });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`git ${args.join(' ')} exited with ${code}: ${stderr.trim()}`));
        }
      });
    });
  }
}

function copyJsonTreeSanitized(srcDir: string, destDir: string, redact: boolean) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      // SQLite lock/WAL files live alongside .db files in some OpenCode
      // versions; never touch them, and never sync a live-locked db file.
      if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm') || entry.name.endsWith('.lock')) {
        continue;
      }
      copyJsonTreeSanitized(srcPath, destPath, redact);
      continue;
    }

    if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm') || entry.name.endsWith('.lock')) {
      continue;
    }

    const raw = fs.readFileSync(srcPath, 'utf8');
    fs.writeFileSync(destPath, redact ? sanitizeJsonFile(raw) : raw, 'utf8');
  }
}
