import * as fs from 'fs';
import * as path from 'path';
import { OpenCodeLocations } from './opencodePaths';
import { sanitizeString } from './secretSanitizer';
import { loadMessages, SessionMessage, SessionRecord } from './sessionScanner';

const MAX_MESSAGES = 20;

export function renderHandoff(record: SessionRecord, messages: SessionMessage[]): string {
  const lines: string[] = [
    `# OpenCode Handoff — ${record.title}`,
    '',
    `- Session ID: \`${record.id}\``,
    `- Directory: \`${record.directory || 'unknown'}\``,
    `- Last updated: ${record.updatedAt ? new Date(record.updatedAt).toISOString() : 'unknown'}`,
    `- Messages: ${record.messageCount}`,
    '',
    `## Last ${Math.min(MAX_MESSAGES, messages.length)} messages`,
    '',
  ];

  for (const msg of messages.slice(-MAX_MESSAGES)) {
    if (!msg.text.trim()) {
      continue;
    }
    lines.push(`### ${msg.role}`, '', sanitizeString(msg.text).trim(), '');
  }

  return lines.join('\n');
}

/**
 * Writes a human-readable snapshot to `.opencode/HANDOFF.md`, a fallback
 * record for when JSON/SQLite sync can't be trusted between machines.
 */
export function generateHandoff(
  locations: OpenCodeLocations,
  record: SessionRecord,
  workspaceRoot: string
): string {
  const dir = path.join(workspaceRoot, '.opencode');
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, 'HANDOFF.md');
  fs.writeFileSync(filePath, renderHandoff(record, loadMessages(locations, record)), 'utf8');
  return filePath;
}
