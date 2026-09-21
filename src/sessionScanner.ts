import * as fs from 'fs';
import * as path from 'path';
import { OpenCodeLocations } from './opencodePaths';

export interface SessionMessage {
  id: string;
  role: string;
  text: string;
  createdAt: number;
}

export type SessionSource = 'sqlite' | 'storage-json' | 'legacy-json';

export interface SessionRecord {
  id: string;
  title: string;
  /** Absolute directory this session was created in, as recorded on its origin machine. */
  directory: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  source: SessionSource;
}

export interface ScanResult {
  sessions: SessionRecord[];
  /** Non-fatal problems worth surfacing (e.g. SQLite unreadable on this Node build). */
  warnings: string[];
}

/**
 * OpenCode's on-disk session format changed twice, and a real machine can hold
 * all three at once (migrations copy rather than delete). `opencode session
 * list` only ever shows the current project, so reading every generation here
 * is what makes a machine-wide listing possible.
 *
 *  1. SQLite   — <dataRoot>/opencode.db, tables session/message/part
 *  2. storage  — <dataRoot>/storage/session/<projectID>/<sessionID>.json
 *                <dataRoot>/storage/message/<sessionID>/<messageID>.json
 *                <dataRoot>/storage/part/<messageID>/<partID>.json
 *  3. legacy   — <dataRoot>/project/<projectDir>/storage/session/info/<id>.json
 *
 * Newer generations win on id collisions, since migration copies forward.
 */
export function scanSessions(locations: OpenCodeLocations): ScanResult {
  const warnings: string[] = [];
  const byId = new Map<string, SessionRecord>();

  for (const record of readLegacySessions(locations.dataRoot)) {
    byId.set(record.id, record);
  }
  for (const record of readStorageSessions(locations.storageRoot)) {
    byId.set(record.id, record);
  }

  const sqlite = readSqliteSessions(locations.databasePath);
  for (const record of sqlite.sessions) {
    byId.set(record.id, record);
  }
  warnings.push(...sqlite.warnings);

  const sessions = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions, warnings };
}

export function loadMessages(locations: OpenCodeLocations, record: SessionRecord): SessionMessage[] {
  switch (record.source) {
    case 'sqlite':
      return loadSqliteMessages(locations.databasePath, record.id);
    case 'storage-json':
      return loadStorageMessages(locations.storageRoot, record.id);
    case 'legacy-json':
      return loadLegacyMessages(locations.dataRoot, record.id);
  }
}

/**
 * Permanently removes a session's own files from this machine's OpenCode
 * storage. This only ever touches the local copy — sync repo history and
 * any other machine's copy are untouched, since deleting a session locally
 * is not itself something the sync plan is asked to propagate (session
 * directories merge rather than mirror precisely so an incomplete local
 * state can't wipe another machine's history).
 */
export function deleteSession(locations: OpenCodeLocations, record: SessionRecord): void {
  switch (record.source) {
    case 'sqlite':
      deleteSqliteSession(locations.databasePath, record.id);
      return;
    case 'storage-json':
      deleteStorageSession(locations.storageRoot, record);
      return;
    case 'legacy-json':
      deleteLegacySession(locations.dataRoot, record);
      return;
  }
}

// ---------------------------------------------------------------- SQLite ---

interface SqliteHandle {
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
  close(): void;
}

/**
 * `node:sqlite` only exists on Node 22.5+. VS Code ships older Node on many
 * releases, so this must degrade to a warning rather than breaking the
 * JSON-storage listing.
 */
function openDatabase(databasePath: string): SqliteHandle | { error: string } {
  if (!fs.existsSync(databasePath)) {
    return { error: '' };
  }

  let DatabaseSync: new (p: string, o?: Record<string, unknown>) => SqliteHandle;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return {
      error:
        'Found opencode.db but this VS Code build has no node:sqlite (needs Node 22.5+). Showing JSON-storage sessions only.',
    };
  }

  try {
    // readOnly keeps us from ever taking a write lock on a live database.
    return new DatabaseSync(databasePath, { readOnly: true });
  } catch (err) {
    return { error: `Could not open opencode.db read-only: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function readSqliteSessions(databasePath: string): ScanResult {
  const handle = openDatabase(databasePath);
  if ('error' in handle) {
    return { sessions: [], warnings: handle.error ? [handle.error] : [] };
  }

  try {
    // A correlated subquery here (`(SELECT COUNT(*) FROM message m WHERE
    // m.session_id = s.id)` per session row) runs one scan of the message
    // table PER SESSION — with a few hundred sessions and a message table
    // that's grown into the hundreds of thousands of rows, that's a few
    // hundred full scans done synchronously, which can block the whole
    // extension host for a very long time. Aggregating message counts once
    // via GROUP BY and joining that single result is the same information,
    // computed with one scan total instead of N.
    const rows = handle
      .prepare(
        `SELECT s.id           AS id,
                s.title        AS title,
                s.directory    AS directory,
                s.project_id   AS project_id,
                s.time_created AS time_created,
                s.time_updated AS time_updated,
                COALESCE(mc.message_count, 0) AS message_count
           FROM session s
           LEFT JOIN (
                SELECT session_id, COUNT(*) AS message_count
                  FROM message
                 GROUP BY session_id
           ) mc ON mc.session_id = s.id
          ORDER BY s.time_updated DESC`
      )
      .all();

    const sessions = rows.map((row) => ({
      id: String(row.id),
      title: String(row.title ?? '') || `Session ${String(row.id).slice(0, 8)}`,
      directory: String(row.directory ?? ''),
      projectId: String(row.project_id ?? ''),
      createdAt: toMillis(row.time_created),
      updatedAt: toMillis(row.time_updated ?? row.time_created),
      messageCount: Number(row.message_count ?? 0),
      source: 'sqlite' as const,
    }));
    return { sessions, warnings: [] };
  } catch (err) {
    return {
      sessions: [],
      warnings: [`Could not query opencode.db: ${err instanceof Error ? err.message : String(err)}`],
    };
  } finally {
    handle.close();
  }
}

function loadSqliteMessages(databasePath: string, sessionId: string): SessionMessage[] {
  const handle = openDatabase(databasePath);
  if ('error' in handle) {
    return [];
  }

  try {
    const rows = handle
      .prepare(
        `SELECT m.id AS id, m.time_created AS time_created, m.data AS message_data,
                (SELECT group_concat(p.data, char(10)) FROM part p WHERE p.message_id = m.id) AS part_data
           FROM message m
          WHERE m.session_id = ?
          ORDER BY m.time_created ASC, m.id ASC`
      )
      .all(sessionId);

    return rows.map((row) => ({
      id: String(row.id),
      role: extractRole(parseJson(row.message_data)),
      text: extractPartsText(row.part_data),
      createdAt: toMillis(row.time_created),
    }));
  } catch {
    return [];
  } finally {
    handle.close();
  }
}

/**
 * Deletes a session's rows from opencode.db. This needs write access, so it
 * cannot reuse `openDatabase()` (which is deliberately readOnly to never
 * take a write lock on a database OpenCode has open). part/message rows are
 * deleted explicitly rather than relying on ON DELETE CASCADE, since
 * cascading only applies when the connection has PRAGMA foreign_keys turned
 * on, which is not the default for a bare connection.
 */
function deleteSqliteSession(databasePath: string, sessionId: string): void {
  if (!fs.existsSync(databasePath)) {
    return;
  }

  let DatabaseSync: new (p: string, o?: Record<string, unknown>) => {
    prepare(sql: string): { run(...params: unknown[]): void };
    close(): void;
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return;
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.prepare('DELETE FROM part WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM message WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session WHERE id = ?').run(sessionId);
  } finally {
    db.close();
  }
}

function extractPartsText(concatenated: unknown): string {
  if (typeof concatenated !== 'string') {
    return '';
  }
  return concatenated
    .split('\n')
    .map((line) => extractText(parseJson(line)))
    .filter(Boolean)
    .join('\n');
}

// -------------------------------------------------------- storage/*.json ---

function readStorageSessions(storageRoot: string): SessionRecord[] {
  const sessionRoot = path.join(storageRoot, 'session');
  if (!isDir(sessionRoot)) {
    return [];
  }

  const worktrees = readProjectWorktrees(path.join(storageRoot, 'project'));
  const records: SessionRecord[] = [];

  for (const projectId of listDir(sessionRoot)) {
    const projectDir = path.join(sessionRoot, projectId);
    if (!isDir(projectDir)) {
      continue;
    }

    for (const file of listDir(projectDir)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const raw = readJson(path.join(projectDir, file));
      if (!raw) {
        continue;
      }

      const id = String(raw.id ?? path.basename(file, '.json'));
      records.push({
        id,
        title: String(raw.title ?? '') || `Session ${id.slice(0, 8)}`,
        directory: String(raw.directory ?? worktrees.get(projectId) ?? ''),
        projectId,
        createdAt: toMillis(readTime(raw, 'created')),
        updatedAt: toMillis(readTime(raw, 'updated') ?? readTime(raw, 'created')),
        messageCount: countDir(path.join(storageRoot, 'message', id)),
        source: 'storage-json',
      });
    }
  }

  return records;
}

function readProjectWorktrees(projectDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!isDir(projectDir)) {
    return map;
  }
  for (const file of listDir(projectDir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const raw = readJson(path.join(projectDir, file));
    if (raw && typeof raw.worktree === 'string') {
      map.set(path.basename(file, '.json'), raw.worktree);
    }
  }
  return map;
}

function loadStorageMessages(storageRoot: string, sessionId: string): SessionMessage[] {
  const messageDir = path.join(storageRoot, 'message', sessionId);
  if (!isDir(messageDir)) {
    return [];
  }

  const messages: SessionMessage[] = [];
  for (const file of listDir(messageDir).filter((f) => f.endsWith('.json')).sort()) {
    const raw = readJson(path.join(messageDir, file));
    if (!raw) {
      continue;
    }
    const messageId = String(raw.id ?? path.basename(file, '.json'));
    messages.push({
      id: messageId,
      role: extractRole(raw),
      text: readPartTexts(path.join(storageRoot, 'part', messageId)) || extractText(raw),
      createdAt: toMillis(readTime(raw, 'created')),
    });
  }

  return messages.sort((a, b) => a.createdAt - b.createdAt);
}

function readPartTexts(partDir: string): string {
  if (!isDir(partDir)) {
    return '';
  }
  return listDir(partDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => extractText(readJson(path.join(partDir, file))))
    .filter(Boolean)
    .join('\n');
}

function deleteStorageSession(storageRoot: string, record: SessionRecord): void {
  const messageDir = path.join(storageRoot, 'message', record.id);
  for (const file of listDir(messageDir).filter((f) => f.endsWith('.json'))) {
    const raw = readJson(path.join(messageDir, file));
    const messageId = String(raw?.id ?? path.basename(file, '.json'));
    removeDir(path.join(storageRoot, 'part', messageId));
  }
  removeDir(messageDir);
  removeFile(path.join(storageRoot, 'session', record.projectId, `${record.id}.json`));
}

// --------------------------------------------------------- legacy layout ---

function readLegacySessions(dataRoot: string): SessionRecord[] {
  const projectRoot = path.join(dataRoot, 'project');
  if (!isDir(projectRoot)) {
    return [];
  }

  const records: SessionRecord[] = [];
  for (const projectId of listDir(projectRoot)) {
    const infoDir = path.join(projectRoot, projectId, 'storage', 'session', 'info');
    if (!isDir(infoDir)) {
      continue;
    }

    for (const file of listDir(infoDir)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const raw = readJson(path.join(infoDir, file));
      if (!raw) {
        continue;
      }
      const id = String(raw.id ?? path.basename(file, '.json'));
      records.push({
        id,
        title: String(raw.title ?? '') || `Session ${id.slice(0, 8)}`,
        directory: String(raw.directory ?? raw.cwd ?? ''),
        projectId,
        createdAt: toMillis(readTime(raw, 'created')),
        updatedAt: toMillis(readTime(raw, 'updated') ?? readTime(raw, 'created')),
        messageCount: countDir(path.join(projectRoot, projectId, 'storage', 'session', 'message', id)),
        source: 'legacy-json',
      });
    }
  }

  return records;
}

function loadLegacyMessages(dataRoot: string, sessionId: string): SessionMessage[] {
  const projectRoot = path.join(dataRoot, 'project');
  if (!isDir(projectRoot)) {
    return [];
  }

  for (const projectId of listDir(projectRoot)) {
    const messageDir = path.join(projectRoot, projectId, 'storage', 'session', 'message', sessionId);
    if (!isDir(messageDir)) {
      continue;
    }

    const partRoot = path.join(projectRoot, projectId, 'storage', 'session', 'part', sessionId);
    const messages: SessionMessage[] = [];
    for (const file of listDir(messageDir).filter((f) => f.endsWith('.json')).sort()) {
      const raw = readJson(path.join(messageDir, file));
      if (!raw) {
        continue;
      }
      const messageId = String(raw.id ?? path.basename(file, '.json'));
      messages.push({
        id: messageId,
        role: extractRole(raw),
        text: readPartTexts(path.join(partRoot, messageId)) || extractText(raw),
        createdAt: toMillis(readTime(raw, 'created')),
      });
    }
    return messages.sort((a, b) => a.createdAt - b.createdAt);
  }

  return [];
}

function deleteLegacySession(dataRoot: string, record: SessionRecord): void {
  const base = path.join(dataRoot, 'project', record.projectId, 'storage', 'session');
  // Unlike storage-json (where parts live in a global storage/part/<messageId>/
  // shared across all sessions), the legacy layout nests parts under
  // storage/session/part/<sessionId>/<messageId>/ — exclusively owned by this
  // session, so the whole subtree can go at once.
  removeDir(path.join(base, 'part', record.id));
  removeDir(path.join(base, 'message', record.id));
  removeFile(path.join(base, 'info', `${record.id}.json`));
}

// ---------------------------------------------------------------- shared ---

function extractRole(raw: Record<string, unknown> | null): string {
  if (!raw) {
    return 'unknown';
  }
  if (typeof raw.role === 'string') {
    return raw.role;
  }
  const data = raw.data as Record<string, unknown> | undefined;
  if (data && typeof data.role === 'string') {
    return data.role;
  }
  return 'unknown';
}

export function extractText(raw: Record<string, unknown> | null): string {
  if (!raw) {
    return '';
  }
  if (typeof raw.text === 'string') {
    return raw.text;
  }
  if (typeof raw.content === 'string') {
    return raw.content;
  }
  if (Array.isArray(raw.content)) {
    return raw.content
      .map((part) => (typeof part === 'string' ? part : String((part as { text?: string })?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  if (raw.data && typeof raw.data === 'object') {
    return extractText(raw.data as Record<string, unknown>);
  }
  return '';
}

function readTime(raw: Record<string, unknown>, key: 'created' | 'updated'): unknown {
  const time = raw.time as Record<string, unknown> | undefined;
  if (time && time[key] !== undefined) {
    return time[key];
  }
  return raw[`time_${key}`] ?? raw[key] ?? raw[`${key}At`];
}

function toMillis(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // OpenCode stores epoch milliseconds; anything far smaller is seconds.
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return parseJson(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function countDir(dir: string): number {
  return listDir(dir).filter((f) => f.endsWith('.json')).length;
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a missing or locked directory shouldn't block the rest of the delete.
  }
}

function removeFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort, same as removeDir.
  }
}
