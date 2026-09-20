import * as fs from 'fs';
import { OpenCodeLocations } from './opencodePaths';
import { SyncManager, SyncSettings } from './syncManager';

/**
 * The exact question this exists to answer: "the panel says Synced — do I
 * actually have my latest work on GitHub, or is something being silently
 * skipped?" A status badge and an ahead/behind count both stay green even
 * when opencode.db has been skipped on every sync (an actively-writing WAL
 * makes that the common case), so this dumps the underlying facts a badge
 * can't show: real file sizes/timestamps on disk versus what was actually
 * last committed to the sync repo.
 */
export async function buildDebugReport(
  locations: OpenCodeLocations,
  settings: SyncSettings,
  manager: SyncManager
): Promise<string> {
  const lines: string[] = [];
  lines.push('=== OpenCode Session Hub — Debug Report ===');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('-- Settings --');
  lines.push(`includeSessions: ${settings.includeSessions}`);
  lines.push(`includeSecrets: ${settings.includeSecrets}`);
  lines.push(`privateRepoAcknowledged: ${settings.privateRepoAcknowledged}`);
  const secretsAllowed = settings.includeSecrets && settings.privateRepoAcknowledged;
  if (settings.includeSessions && !secretsAllowed) {
    lines.push(
      '  WARNING: session history is NOT syncing. includeSessions is on, but includeSecrets and/or ' +
        'privateRepoAcknowledged is off — every sync silently skips all session data.'
    );
  }
  lines.push('');

  lines.push('-- Local OpenCode paths --');
  lines.push(`dataRoot: ${locations.dataRoot}`);
  lines.push(`configRoot: ${locations.configRoot}`);
  lines.push(`databasePath: ${locations.databasePath}`);
  lines.push('');

  lines.push('-- opencode.db on disk right now --');
  const dbStat = await statOrNull(locations.databasePath);
  lines.push(
    dbStat
      ? `opencode.db: ${dbStat.size} bytes, last modified ${dbStat.mtime.toISOString()}`
      : 'opencode.db: does not exist on this machine'
  );
  const walStat = await statOrNull(`${locations.databasePath}-wal`);
  if (walStat && walStat.size > 0) {
    lines.push(
      `opencode.db-wal: ${walStat.size} bytes — uncheckpointed writes. If this is still non-zero after a ` +
        'push, OpenCode is writing continuously enough that the safe checkpoint attempt could not fully drain it; ' +
        'the db will be skipped again until a lull.'
    );
  } else {
    lines.push('opencode.db-wal: absent or empty — nothing pending a checkpoint right now.');
  }
  lines.push('');

  lines.push('-- Sync repository --');
  lines.push(await manager.debugReport());

  return lines.join('\n');
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target);
  } catch {
    return null;
  }
}
