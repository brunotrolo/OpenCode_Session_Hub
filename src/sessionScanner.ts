import * as fs from 'fs';
import * as path from 'path';

export interface SessionMessage {
  role?: string;
  content?: string;
  text?: string;
  [key: string]: unknown;
}

export interface SessionRecord {
  id: string;
  title: string;
  directory: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  infoFilePath: string;
  messageDir: string | null;
}

/**
 * OpenCode keeps a per-project storage tree under the global storage root, e.g.:
 *   <root>/project/<project-id>/storage/session/info/<session-id>.json
 *   <root>/project/<project-id>/storage/session/message/<session-id>/<message-id>.json
 *
 * `opencode session list` only ever looks inside the single project tree that
 * matches the current working directory, which is why sessions from other
 * repositories never show up. This scanner walks every project folder under
 * the storage root so the whole machine's history can be listed at once.
 */
export function findAllSessions(storageRoot: string): SessionRecord[] {
  const projectRoot = path.join(storageRoot, 'project');
  if (!fs.existsSync(projectRoot)) {
    return [];
  }

  const sessions: SessionRecord[] = [];

  for (const projectId of safeReadDir(projectRoot)) {
    const infoDir = path.join(projectRoot, projectId, 'storage', 'session', 'info');
    if (!fs.existsSync(infoDir)) {
      continue;
    }

    for (const file of safeReadDir(infoDir)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const infoFilePath = path.join(infoDir, file);
      const record = parseSessionInfo(infoFilePath, projectId);
      if (record) {
        sessions.push(record);
      }
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

function parseSessionInfo(infoFilePath: string, projectId: string): SessionRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(infoFilePath, 'utf8'));
    const id: string = raw.id || path.basename(infoFilePath, '.json');
    const title: string = raw.title || raw.name || `Session ${id.slice(0, 8)}`;
    const directory: string = raw.directory || raw.cwd || raw.workspace || raw.path || 'unknown';
    const created = pickTimestamp(raw.time?.created ?? raw.created ?? raw.createdAt);
    const updated = pickTimestamp(raw.time?.updated ?? raw.updated ?? raw.updatedAt ?? created);

    const messageDir = path.join(path.dirname(path.dirname(infoFilePath)), 'message', id);
    const messageCount = fs.existsSync(messageDir)
      ? safeReadDir(messageDir).filter((f) => f.endsWith('.json')).length
      : 0;

    return {
      id,
      title,
      directory,
      projectId,
      createdAt: created,
      updatedAt: updated,
      messageCount,
      infoFilePath,
      messageDir: fs.existsSync(messageDir) ? messageDir : null,
    };
  } catch {
    return null;
  }
}

export function loadSessionMessages(record: SessionRecord): SessionMessage[] {
  if (!record.messageDir) {
    return [];
  }

  const files = safeReadDir(record.messageDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const messages: SessionMessage[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(record.messageDir, file), 'utf8'));
      messages.push(raw);
    } catch {
      // Skip unreadable/corrupt message files rather than failing the whole preview.
    }
  }
  return messages;
}

function pickTimestamp(value: unknown): number {
  if (typeof value === 'number') {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
