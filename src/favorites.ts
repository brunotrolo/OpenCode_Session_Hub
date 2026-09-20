import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { OpenCodeLocations } from './opencodePaths';

export interface FavoriteSession {
  /** Local bookmark id — stable identity for editing/removing, independent of the OpenCode session id. */
  id: string;
  /** Free-text note, e.g. "Sessao de Desenvolvimento de HTML Hello World". */
  label: string;
  /** The OpenCode session id this bookmark points at, e.g. "ses_f4a55ea3effe...". */
  sessionId: string;
  createdAt: number;
}

export const FAVORITES_FILE_NAME = 'opencode-session-hub-favorites.json';

/**
 * Favorites live inside the OpenCode config directory as a plain JSON file,
 * which the sync plan already mirrors on every push/pull alongside
 * opencode.json and AGENTS.md — so a bookmark added on one machine shows up
 * on the other with no extra sync wiring needed.
 */
function favoritesFilePath(locations: OpenCodeLocations): string {
  return path.join(locations.configRoot, FAVORITES_FILE_NAME);
}

export function loadFavorites(locations: OpenCodeLocations): FavoriteSession[] {
  try {
    const raw = JSON.parse(fs.readFileSync(favoritesFilePath(locations), 'utf8'));
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        id: String(entry.id ?? crypto.randomUUID()),
        label: String(entry.label ?? ''),
        sessionId: String(entry.sessionId ?? ''),
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
      }))
      .filter((entry) => entry.sessionId.length > 0)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function saveFavorites(locations: OpenCodeLocations, favorites: FavoriteSession[]): void {
  fs.mkdirSync(locations.configRoot, { recursive: true });
  fs.writeFileSync(favoritesFilePath(locations), JSON.stringify(favorites, null, 2), 'utf8');
}

export function addFavorite(locations: OpenCodeLocations, label: string, sessionId: string): FavoriteSession {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) {
    throw new Error('Session Id is required.');
  }

  const favorite: FavoriteSession = {
    id: crypto.randomUUID(),
    label: label.trim() || trimmedSessionId,
    sessionId: trimmedSessionId,
    createdAt: Date.now(),
  };

  const favorites = loadFavorites(locations);
  favorites.unshift(favorite);
  saveFavorites(locations, favorites);
  return favorite;
}

export function removeFavorite(locations: OpenCodeLocations, id: string): void {
  const favorites = loadFavorites(locations).filter((favorite) => favorite.id !== id);
  saveFavorites(locations, favorites);
}

/** Drops every bookmark pointing at a session id — used when that session itself is deleted. */
export function removeFavoritesBySessionId(locations: OpenCodeLocations, sessionId: string): number {
  const before = loadFavorites(locations);
  const after = before.filter((favorite) => favorite.sessionId !== sessionId);
  if (after.length !== before.length) {
    saveFavorites(locations, after);
  }
  return before.length - after.length;
}
