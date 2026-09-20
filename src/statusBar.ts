import * as vscode from 'vscode';
import { SyncStatus } from './syncManager';

const ICONS: Record<SyncStatus, string> = {
  idle: '$(check) OpenCode synced',
  syncing: '$(sync~spin) OpenCode syncing…',
  error: '$(error) OpenCode sync error',
  unconfigured: '$(circle-slash) OpenCode sync not configured',
};

export class SyncStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'opencodeSessionHub.syncPush';
    this.set('idle');
    this.item.show();
  }

  set(status: SyncStatus) {
    this.item.text = ICONS[status];
    this.item.tooltip =
      status === 'unconfigured'
        ? 'Set opencodeSessionHub.syncRemoteUrl to enable session sync.'
        : 'Click to sync OpenCode sessions now.';
  }

  dispose() {
    this.item.dispose();
  }
}
