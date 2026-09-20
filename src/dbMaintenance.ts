import * as fs from 'fs';

export type VacuumResult =
  | { ok: true; beforeBytes: number; afterBytes: number }
  | { ok: false; error: string };

interface VacuumHandle {
  exec(sql: string): void;
  close(): void;
}

/**
 * Shrinks opencode.db in place via SQLite's own VACUUM, which rewrites the
 * whole file with deleted-row space reclaimed. This is the direct fix for
 * the "database has grown to several GB" report — that size is almost
 * always freelist bloat from deleted rows, not that much real session
 * history, and VACUUM is the standard SQLite tool for reclaiming it (the
 * same operation the manual `sqlite3 opencode.db "VACUUM;"` workaround runs,
 * just without requiring the sqlite3 CLI to be installed).
 *
 * VACUUM needs a connection SQLite considers exclusive enough to rewrite the
 * whole file, so this can't safely run while OpenCode itself has the
 * database open and active — callers should tell the user to close OpenCode
 * first. A locked-database error is caught and reported clearly rather than
 * left as a raw SQLite error, since "close OpenCode and try again" is the
 * actual fix.
 */
export async function vacuumDatabase(databasePath: string): Promise<VacuumResult> {
  let DatabaseSync: new (p: string, o?: Record<string, unknown>) => VacuumHandle;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { ok: false, error: 'This VS Code build has no node:sqlite (needs Node 22.5+).' };
  }

  const beforeStat = await statOrNull(databasePath);
  if (!beforeStat) {
    return { ok: false, error: `${databasePath} does not exist on this machine.` };
  }

  let db: VacuumHandle | undefined;
  try {
    db = new DatabaseSync(databasePath);
    // A passive checkpoint first folds any pending WAL frames into the main
    // file, so VACUUM rewrites the database's actual current state rather
    // than potentially missing very recent writes.
    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch {
      // Best-effort — VACUUM below still runs against whatever the main file
      // currently holds even if this didn't fully drain the WAL.
    }
    db.exec('VACUUM;');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const locked = /locked|busy/i.test(message);
    return {
      ok: false,
      error: locked
        ? 'The database is in use (locked or busy) — close OpenCode (and any other program with it open) and try again.'
        : `VACUUM failed: ${message}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  const afterStat = await statOrNull(databasePath);
  return { ok: true, beforeBytes: beforeStat.size, afterBytes: afterStat?.size ?? beforeStat.size };
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target);
  } catch {
    return null;
  }
}
