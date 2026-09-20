import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * A session's `directory` field was recorded on whatever machine created it
 * (e.g. C:\Projetos\meu-repo at home vs /home/user/meu-repo at work). This
 * resolves it against the folders actually open/known on THIS machine by
 * matching folder basenames and git remote URLs, so opening a session never
 * requires the original absolute path to exist.
 */
export function resolveLocalDirectory(recordedDirectory: string): string | null {
  if (fs.existsSync(recordedDirectory)) {
    return recordedDirectory;
  }

  const targetBasename = path.basename(recordedDirectory.replace(/[\\/]+$/, ''));
  const candidates = collectCandidateFolders();

  const exactNameMatch = candidates.find(
    (dir) => path.basename(dir).toLowerCase() === targetBasename.toLowerCase()
  );
  if (exactNameMatch) {
    return exactNameMatch;
  }

  return null;
}

function collectCandidateFolders(): string[] {
  const folders = new Set<string>();

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    folders.add(folder.uri.fsPath);
  }

  const recentSetting = vscode.workspace
    .getConfiguration('opencodeSessionHub')
    .get<string[]>('knownWorkspaceRoots', []);
  for (const root of recentSetting) {
    if (fs.existsSync(root)) {
      for (const entry of safeReadDir(root)) {
        folders.add(path.join(root, entry));
      }
    }
  }

  return [...folders];
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((entry) => {
      try {
        return fs.statSync(path.join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
