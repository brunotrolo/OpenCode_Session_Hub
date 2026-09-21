import * as fs from 'fs';

export type VacuumResult =
  | {
      ok: true;
      beforeBytes: number;
      afterBytes: number;
      walBeforeBytes: number;
      walAfterBytes: number;
      /** Set when the WAL checkpoint couldn't fully drain — something still has the database open despite the "close OpenCode" instruction. */
      walWarning?: string;
    }
  | { ok: false; error: string };

interface CheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

interface VacuumHandle {
  exec(sql: string): void;
  prepare(sql: string): { get(): Record<string, unknown> | undefined };
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
  const walPath = `${databasePath}-wal`;
  const walBeforeStat = await statOrNull(walPath);

  let db: VacuumHandle | undefined;
  let walWarning: string | undefined;
  try {
    db = new DatabaseSync(databasePath);

    // TRUNCATE (not the PASSIVE mode syncManager.ts uses during a live sync)
    // is what actually shrinks the WAL file back to empty — PASSIVE only
    // folds committed frames into the main file without truncating it. This
    // is safe to demand here specifically because the caller has already
    // told the user to close OpenCode first; unlike a background sync, this
    // operation is allowed to require exclusive access.
    try {
      const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get() as unknown as CheckpointRow | undefined;
      if (row && Number(row.busy) !== 0) {
        walWarning =
          'The WAL checkpoint could not fully complete — something still has opencode.db open ' +
          '(check for a lingering OpenCode or sqlite3 process) even though it was supposed to be closed. ' +
          'The database was still compacted, but the WAL file may not have fully shrunk.';
      }
    } catch (err) {
      walWarning = `Could not checkpoint the WAL before compacting: ${
        err instanceof Error ? err.message : String(err)
      }`;
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
  const walAfterStat = await statOrNull(walPath);
  const walAfterBytes = walAfterStat?.size ?? 0;

  // A TRUNCATE checkpoint can report success (busy=0 — every frame got
  // merged) and still leave the WAL file at its prior size: SQLite only
  // truncates the file itself when NO other connection has it mapped, even
  // an idle one with no in-flight transaction. That's a distinct, more
  // common failure mode than the pinned-reader case above (a Task
  // Manager-invisible "OpenCode isn't really closed" is far more likely
  // than a stuck read transaction), so it's checked directly against the
  // outcome rather than trusting the pragma's own busy flag alone.
  if (!walWarning && walAfterBytes > 0) {
    walWarning =
      'The WAL file did not shrink after compacting — another connection still has opencode.db open (this can ' +
      'happen even without an active read/write, if the process itself is still running). Close OpenCode ' +
      'completely and check for a lingering process before trying again.';
  }

  return {
    ok: true,
    beforeBytes: beforeStat.size,
    afterBytes: afterStat?.size ?? beforeStat.size,
    walBeforeBytes: walBeforeStat?.size ?? 0,
    walAfterBytes,
    walWarning,
  };
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target);
  } catch {
    return null;
  }
}
