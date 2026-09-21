import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { loadFavorites } from './favorites';
import { OpenCodeLocations } from './opencodePaths';
import { SyncManager, SyncSettings } from './syncManager';

/** Matches OVERSIZED_FILE_SKIP_BYTES in syncManager.ts — kept as a literal here so this module doesn't need to import an internal constant just to word a warning. */
const OVERSIZED_FILE_SKIP_MB = 90;

/**
 * The exact question this exists to answer: "the panel says Synced — do I
 * actually have my latest work on GitHub, or is something being silently
 * skipped?" A status badge and an ahead/behind count both stay green even
 * when opencode.db has been skipped on every sync (an actively-writing WAL
 * makes that the common case), so this dumps the underlying facts a badge
 * can't show: real file sizes/timestamps on disk versus what was actually
 * last committed to the sync repo.
 */
export interface DebugSyncState {
  /** The error from the last failed sync, if the last one failed. */
  lastError?: string;
  status?: string;
  lastSyncAt?: number;
}

export async function buildDebugReport(
  locations: OpenCodeLocations,
  settings: SyncSettings,
  manager: SyncManager,
  syncState: DebugSyncState = {}
): Promise<string> {
  const lines: string[] = [];
  lines.push('=== OpenCode Session Hub — Debug Report ===');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('-- Environment --');
  lines.push(`OS: ${os.platform()} ${os.release()} (${os.arch()})`);
  lines.push(`Node: ${process.version}`);
  lines.push(`node:sqlite available: ${await hasNodeSqlite()}`);
  lines.push(`git: ${await gitVersion()}`);
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
  if (dbStat) {
    const mb = dbStat.size / (1024 * 1024);
    lines.push(`opencode.db: ${dbStat.size} bytes (${mb.toFixed(0)} MB), last modified ${dbStat.mtime.toISOString()}`);
    if (mb > OVERSIZED_FILE_SKIP_MB) {
      lines.push(
        `  WARNING: this is over the ${OVERSIZED_FILE_SKIP_MB} MB sync limit and is being skipped on every ` +
          'push (GitHub hard-rejects any single file over 100 MB, and hashing a file this size costs real time ' +
          'and disk locally too). If this size is unexpected, run VACUUM on it while OpenCode is closed — a ' +
          "database this large usually means bloat from deleted rows, not that much real history. If it's " +
          "genuinely this large, session sync isn't practical for it as-is; leave includeSessions off."
      );
    }
  } else {
    lines.push('opencode.db: does not exist on this machine');
  }
  const walStat = await statOrNull(`${locations.databasePath}-wal`);
  if (walStat && walStat.size > 0) {
    const walMb = walStat.size / (1024 * 1024);
    lines.push(
      `opencode.db-wal: ${walStat.size} bytes (${walMb.toFixed(0)} MB) — uncheckpointed writes. If this is ` +
        'still non-zero after a push, OpenCode is writing continuously enough that the safe checkpoint attempt ' +
        'could not fully drain it; the db will be skipped again until a lull.'
    );
    if (walMb > OVERSIZED_FILE_SKIP_MB) {
      lines.push(
        `  WARNING: a WAL file this large (especially if it's comparable to or bigger than opencode.db itself) ` +
          "is not normal — a PASSIVE checkpoint only ever merges what it can without blocking, so it never shrinks " +
          'this file. This usually means something is holding the database open continuously (OpenCode running, ' +
          'or a leftover process from a previous run) and preventing a full checkpoint, rather than genuinely ' +
          'huge write volume. "Compact Database" uses a TRUNCATE checkpoint instead, which does shrink this file ' +
          '— but only if the database is genuinely not open anywhere else. If it reports the WAL still could not ' +
          "be fully drained, check Task Manager (or `tasklist | findstr opencode`) for a lingering OpenCode " +
          'process even after closing the window.'
      );
    }
  } else {
    lines.push('opencode.db-wal: absent or empty — nothing pending a checkpoint right now.');
  }
  lines.push('');

  lines.push('-- Favorite sessions (synced individually, one file per session id) --');
  const favorites = loadFavorites(locations);
  if (favorites.length === 0) {
    lines.push('None bookmarked yet — see the sidebar or "Save Favorite".');
  } else {
    lines.push(
      `${favorites.length} bookmarked. Each syncs to its own data/favorite-sessions/<id>.db file regardless of ` +
        "whether opencode.db itself is over the size limit — one session's export failing never blocks the others."
    );
    for (const favorite of favorites) {
      lines.push(`  ${favorite.sessionId} — "${favorite.label}"`);
    }
  }
  lines.push('');

  // Without this the report showed a repo happily N commits ahead and gave
  // no hint that every push had been failing — the error only ever appeared
  // in a transient notification the user had long since dismissed.
  lines.push('-- Last sync result --');
  if (syncState.lastError) {
    lines.push(`LAST SYNC FAILED: ${syncState.lastError}`);
  } else if (syncState.status === 'syncing') {
    lines.push('A sync is running right now (no failure recorded yet).');
  } else {
    lines.push('No sync error recorded.');
  }
  if (syncState.lastSyncAt) {
    lines.push(`Last sync finished: ${new Date(syncState.lastSyncAt).toISOString()}`);
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

async function hasNodeSqlite(): Promise<boolean> {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function gitVersion(): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    try {
      const child = spawn('git', ['--version']);
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.on('error', () => resolve('(git not found on PATH)'));
      child.on('close', (code) => resolve(code === 0 ? stdout.trim() : '(git --version failed)'));
    } catch {
      resolve('(git not found on PATH)');
    }
  });
}
