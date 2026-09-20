import * as vscode from 'vscode';
import { SyncStatus } from './syncManager';

const PRESENTATION: Record<SyncStatus, { text: string; tooltip: string }> = {
  idle: { text: '$(check) OpenCode', tooltip: 'OpenCode sessions are in sync. Click to sync now.' },
  syncing: { text: '$(sync~spin) OpenCode', tooltip: 'Syncing OpenCode sessions…' },
  error: { text: '$(error) OpenCode', tooltip: 'OpenCode sync failed. Click to retry.' },
  unconfigured: {
    text: '$(circle-slash) OpenCode',
    tooltip: 'OpenCode sync is not configured. Run "OpenCode Sync: Initialize Sync Repository".',
  },
  conflict: {
    text: '$(warning) OpenCode',
    tooltip: 'OpenCode sync has conflicts. Run "OpenCode Sync: Resolve Conflicts".',
  },
};

export class SyncStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(initial: SyncStatus) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.set(initial);
    this.item.show();
  }

  set(status: SyncStatus) {
    const { text, tooltip } = PRESENTATION[status];
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.command =
      status === 'conflict' ? 'opencodeSessionHub.syncResolve' : 'opencodeSessionHub.syncPush';
  }

  dispose() {
    this.item.dispose();
  }
}
