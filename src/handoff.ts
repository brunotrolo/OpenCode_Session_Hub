import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadSessionMessages, SessionRecord } from './sessionScanner';
import { sanitizeString } from './secretSanitizer';

/**
 * Writes a lightweight, human-readable Markdown snapshot of a session into
 * `.opencode/HANDOFF.md` in the workspace. Acts as a fallback record if the
 * JSON sync ever fails between machines.
 */
export async function generateHandoff(record: SessionRecord, workspaceRoot: string): Promise<string> {
  const messages = loadSessionMessages(record);
  const dir = path.join(workspaceRoot, '.opencode');
  fs.mkdirSync(dir, { recursive: true });

  const lines: string[] = [
    `# OpenCode Handoff — ${record.title}`,
    '',
    `- Session ID: \`${record.id}\``,
    `- Directory: \`${record.directory}\``,
    `- Last updated: ${new Date(record.updatedAt).toLocaleString()}`,
    `- Messages: ${record.messageCount}`,
    '',
    '## Recent activity',
    '',
  ];

  const tail = messages.slice(-20);
  for (const msg of tail) {
    const role = String(msg.role ?? 'unknown');
    const text = typeof msg.text === 'string' ? msg.text : typeof msg.content === 'string' ? msg.content : '';
    if (!text) {
      continue;
    }
    lines.push(`### ${role}`, '', sanitizeString(text), '');
  }

  const filePath = path.join(dir, 'HANDOFF.md');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

export async function generateHandoffForActiveWorkspace(record: SessionRecord): Promise<string | null> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Open a workspace folder to generate a handoff checkpoint.');
    return null;
  }
  return generateHandoff(record, folder.uri.fsPath);
}
