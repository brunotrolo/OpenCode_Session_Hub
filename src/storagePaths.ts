import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Resolves the OpenCode global storage directory, honoring the user override
 * and falling back to OpenCode's documented per-OS defaults.
 */
export function getOpenCodeStorageRoot(): string {
  const configured = vscode.workspace
    .getConfiguration('opencodeSessionHub')
    .get<string>('storagePath', '')
    .trim();
  if (configured) {
    return configured;
  }

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'opencode');
  }

  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

export function getOpenCodeConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  }
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

export function getExtensionSyncRoot(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace
    .getConfiguration('opencodeSessionHub')
    .get<string>('syncRepoPath', '')
    .trim();
  if (configured) {
    return configured;
  }
  return path.join(context.globalStorageUri.fsPath, 'sync-repo');
}
