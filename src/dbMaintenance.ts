import { spawn } from 'child_process';
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

interface WorkerResult {
  ok: boolean;
  error?: string;
  checkpointBusy?: boolean;
  checkpointError?: string;
}

/**
 * Runs entirely in a separate, throwaway Node process — see the big comment
 * on runVacuumWorker() below for why. Keep this self-contained: it can't
 * import anything from the extension, since it never runs inside it.
 */
const WORKER_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
const databasePath = process.argv[process.argv.length - 1];
const result = { ok: true };
let db;
try {
  db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
    if (row && Number(row.busy) !== 0) {
      result.checkpointBusy = true;
    }
  } catch (err) {
    result.checkpointError = err && err.message ? err.message : String(err);
  }
  db.exec('VACUUM;');
} catch (err) {
  result.ok = false;
  result.error = err && err.message ? err.message : String(err);
} finally {
  try { db && db.close(); } catch {}
}
process.stdout.write(JSON.stringify(result));
`;

/**
 * node:sqlite's exec()/prepare().get() are fully synchronous, and VACUUM on
 * a multi-GB database is a lot of pure disk I/O — potentially minutes. Run
 * inline in the extension host (as this used to), that blocks the ENTIRE
 * Node event loop the whole time: every other extension, all UI messages,
 * and even the "compacting..." progress notification itself (rendering it
 * also has to round-trip through the same blocked event loop). The result
 * looks exactly like "the button did nothing" for as long as it runs.
 *
 * Spawning a separate process keeps the extension host responsive the whole
 * time. `ELECTRON_RUN_AS_NODE` makes VS Code's own bundled Electron binary
 * behave as a plain Node CLI for this one child process — no separate Node
 * installation required, and it's the exact same runtime (and node:sqlite
 * build) already running the extension host, so behavior is identical to
 * what running it inline would have done, just off the main thread. Passing
 * the script via `-e` (not a temp file) means nothing is left on disk.
 */
function runVacuumWorker(databasePath: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', WORKER_SOURCE, '--', databasePath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: `Could not start the compact process: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (err) => resolve({ ok: false, error: `Could not start the compact process: ${err.message}` }));
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout.trim()) as WorkerResult);
      } catch {
        resolve({
          ok: false,
          error: `The compact process produced no usable result.${stderr.trim() ? ` (stderr: ${stderr.trim()})` : ''}`,
        });
      }
    });
  });
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
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:sqlite');
  } catch {
    return { ok: false, error: 'This VS Code build has no node:sqlite (needs Node 22.5+).' };
  }

  const beforeStat = await statOrNull(databasePath);
  if (!beforeStat) {
    return { ok: false, error: `${databasePath} does not exist on this machine.` };
  }
  const walPath = `${databasePath}-wal`;
  const walBeforeStat = await statOrNull(walPath);

  const workerResult = await runVacuumWorker(databasePath);
  if (!workerResult.ok) {
    const message = workerResult.error ?? 'unknown error';
    const locked = /locked|busy/i.test(message);
    return {
      ok: false,
      error: locked
        ? 'The database is in use (locked or busy) — close OpenCode (and any other program with it open) and try again.'
        : `VACUUM failed: ${message}`,
    };
  }

  // TRUNCATE (not the PASSIVE mode syncManager.ts uses during a live sync)
  // is what actually shrinks the WAL file back to empty — PASSIVE only
  // folds committed frames into the main file without truncating it. This
  // is safe to demand here specifically because the caller has already told
  // the user to close OpenCode first; unlike a background sync, this
  // operation is allowed to require exclusive access.
  let walWarning: string | undefined;
  if (workerResult.checkpointBusy) {
    walWarning =
      'The WAL checkpoint could not fully complete — something still has opencode.db open ' +
      '(check for a lingering OpenCode or sqlite3 process) even though it was supposed to be closed. ' +
      'The database was still compacted, but the WAL file may not have fully shrunk.';
  } else if (workerResult.checkpointError) {
    walWarning = `Could not checkpoint the WAL before compacting: ${workerResult.checkpointError}`;
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
