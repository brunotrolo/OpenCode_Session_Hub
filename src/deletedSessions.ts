import * as fs from 'fs';
import * as path from 'path';
import { OpenCodeLocations } from './opencodePaths';

/**
 * Records session ids the user deleted on this machine, so a deletion is not
 * silently undone by the next sync.
 *
 * Sessions reach the sync repo as one exported file per session id, and the
 * pull side merges every such file into the local opencode.db. Without a
 * record of what was deleted, deleting a session locally and then pulling
 * merges it straight back out of its own still-present export file — the
 * Delete button becomes a no-op that quietly reverses itself.
 *
 * A tombstone is a deliberate, explicit statement ("this session is gone"),
 * which is the only thing that can outrank "here is a file containing that
 * session". It lives in the OpenCode config directory next to the favorites
 * file, so the existing sync plan mirrors it with no extra wiring, and a
 * deletion made on one machine propagates to the others rather than each
 * machine re-seeding the others with what they each deleted.
 */

export const DELETED_SESSIONS_FILE_NAME = 'opencode-session-hub-deleted-sessions.json';

export interface DeletedSession {
  sessionId: string;
  deletedAt: number;
}

function deletedSessionsFilePath(locations: OpenCodeLocations): string {
  return path.join(locations.configRoot, DELETED_SESSIONS_FILE_NAME);
}

export function loadDeletedSessions(locations: OpenCodeLocations): DeletedSession[] {
  try {
    const raw = JSON.parse(fs.readFileSync(deletedSessionsFilePath(locations), 'utf8'));
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        sessionId: String(entry.sessionId ?? ''),
        deletedAt: typeof entry.deletedAt === 'number' ? entry.deletedAt : 0,
      }))
      .filter((entry) => entry.sessionId.length > 0);
  } catch {
    return [];
  }
}

export function isSessionDeleted(locations: OpenCodeLocations, sessionId: string): boolean {
  return loadDeletedSessions(locations).some((entry) => entry.sessionId === sessionId);
}

export function markSessionDeleted(locations: OpenCodeLocations, sessionId: string): void {
  const existing = loadDeletedSessions(locations);
  if (existing.some((entry) => entry.sessionId === sessionId)) {
    return;
  }
  const next = [...existing, { sessionId, deletedAt: Date.now() }];
  fs.mkdirSync(locations.configRoot, { recursive: true });
  fs.writeFileSync(deletedSessionsFilePath(locations), JSON.stringify(next, null, 2), 'utf8');
}

/**
 * Drops a tombstone, so a session that is deliberately created again under
 * the same id (or restored from a backup) is no longer treated as deleted.
 */
export function clearSessionDeleted(locations: OpenCodeLocations, sessionId: string): void {
  const existing = loadDeletedSessions(locations);
  const next = existing.filter((entry) => entry.sessionId !== sessionId);
  if (next.length === existing.length) {
    return;
  }
  fs.mkdirSync(locations.configRoot, { recursive: true });
  fs.writeFileSync(deletedSessionsFilePath(locations), JSON.stringify(next, null, 2), 'utf8');
}
