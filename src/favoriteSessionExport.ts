import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Exports one favorited session's rows out of opencode.db into its own
 * small, standalone SQLite file — instead of syncing the whole (possibly
 * multi-GB) database as one blob. Each favorite becomes an independent sync
 * item keyed by session id: one session's export failing (missing locally,
 * belongs to a schema this Node build can't read, etc.) never blocks any
 * other favorite from syncing, unlike the all-or-nothing whole-database
 * path. The output file reuses the exact CREATE TABLE statements from the
 * source database, so it's a real, schema-correct SQLite file that
 * dbMerge.ts's mergeSessionDatabases() can merge straight into another
 * machine's opencode.db with no separate import logic needed.
 */

interface ExportHandle {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): void;
  };
  exec(sql: string): void;
  close(): void;
}

export type ExportResult = { ok: true; rows: number } | { ok: false; error: string };

/** Tables carrying a session's own content, keyed by the column that ties a row to the session. */
const SESSION_TABLES: { name: string; sessionIdColumn: string }[] = [
  { name: 'session', sessionIdColumn: 'id' },
  { name: 'message', sessionIdColumn: 'session_id' },
  { name: 'part', sessionIdColumn: 'session_id' },
];

/**
 * How many sessions share one scan of the message/part tables. OpenCode's
 * schema has no index on session_id, so every filtered read of those tables
 * is a full scan: exporting sessions one at a time costs one scan PER
 * SESSION, which on a real multi-GB database with a few hundred sessions
 * turns a single push into minutes of synchronous work. Batching trades a
 * bounded amount of memory (one chunk's rows) for a proportional cut in
 * scans — 25 at a time means 25x fewer passes over the biggest tables,
 * while never holding more than a chunk's worth of rows at once.
 */
const EXPORT_CHUNK_SIZE = 25;

/**
 * A scratch path for the half-written export, in the OS temp directory
 * rather than beside the final file.
 *
 * The export writes to a temporary file and renames it into place so a
 * crash can never leave a half-written database where a complete one is
 * expected. But the destination lives INSIDE the sync repo's working tree,
 * so putting the scratch file beside it meant an interrupted export (a VS
 * Code restart or extension-host reload mid-export — which a multi-GB
 * database made likely) left `<id>.db.tmp-<pid>-<ts>` behind, and the next
 * `git add -A` committed it. A real repo accumulated five such files from
 * five different runs, one of them over GitHub's 100 MB limit, which then
 * blocked every push. Keeping scratch files out of the repo entirely means
 * that cannot happen again, whatever goes wrong mid-export.
 */
function scratchPathFor(outputPath: string): string {
  return path.join(
    os.tmpdir(),
    `opencode-session-hub-${process.pid}-${Date.now()}-${path.basename(outputPath)}`
  );
}

/**
 * Removes scratch files an older build left inside the repo. Without this,
 * an existing mirror keeps committing the ones already on disk forever.
 */
export async function removeStrayExportTempFiles(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of entries) {
    if (!/\.tmp-\d+-\d+$/.test(name)) {
      continue;
    }
    try {
      await fs.promises.rm(path.join(directory, name), { force: true });
      removed.push(name);
    } catch {
      // Best-effort: a locked stray file shouldn't fail the whole sync.
    }
  }
  return removed;
}

/**
 * Moves the finished export into the repo. A plain rename fails with EXDEV
 * when the OS temp directory and the repo are on different filesystems
 * (routine on Windows, where TEMP is often on a different volume), so fall
 * back to copy-then-delete. The copy still lands atomically enough for our
 * purposes: readers only ever see the destination once it is complete,
 * because nothing reads it until the push that follows.
 */
async function moveIntoPlace(tmpPath: string, outputPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.promises.rename(tmpPath, outputPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') {
      throw err;
    }
    await fs.promises.copyFile(tmpPath, outputPath);
    await fs.promises.rm(tmpPath, { force: true });
  }
}

export interface BatchExportEntry {
  sessionId: string;
  outputPath: string;
}

export type BatchExportResult = { sessionId: string } & ExportResult;

/**
 * Exports many sessions, each to its own standalone file, reading the source
 * database ONCE and scanning each table once per chunk rather than once per
 * session (see EXPORT_CHUNK_SIZE). Results come back per session in the
 * order given, so one session failing to export never affects the others —
 * the same independence the one-file-per-session design exists for.
 */
/**
 * Runs exportSessionFilesBatched in a throwaway child process, falling back
 * to running it inline if the child can't be started.
 *
 * node:sqlite is fully synchronous, so even the batched export blocks the
 * entire extension host for as long as it runs — and on the multi-GB
 * database this feature exists to work around, that is long enough to
 * freeze the whole VS Code window on every push. The child writes the export
 * files straight to disk, so only a small JSON summary crosses the process
 * boundary. The worker requires THIS compiled module rather than
 * reimplementing the export, so there is only ever one copy of the logic.
 */
export function exportSessionFilesOffThread(
  databasePath: string,
  entries: BatchExportEntry[]
): Promise<BatchExportResult[]> {
  if (entries.length === 0) {
    return Promise.resolve([]);
  }

  const workerSource = `
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  try {
    const { databasePath, entries } = JSON.parse(input);
    const mod = require(${JSON.stringify(__filename)});
    const results = await mod.exportSessionFilesBatched(databasePath, entries);
    process.stdout.write(JSON.stringify(results));
  } catch (err) {
    process.stdout.write(JSON.stringify({ __error: err && err.message ? err.message : String(err) }));
  }
});
`;

  return new Promise((resolve) => {
    const runInline = () => resolve(exportSessionFilesBatched(databasePath, entries));

    let child;
    try {
      child = spawn(process.execPath, ['-e', workerSource], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      runInline();
      return;
    }

    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', () => undefined);
    child.on('error', () => runInline());
    child.on('close', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        // The child produced nothing usable (no node:sqlite, a crash): fall
        // back to running inline rather than silently syncing no sessions.
        runInline();
        return;
      }
      if (!Array.isArray(parsed)) {
        runInline();
        return;
      }
      resolve(parsed as BatchExportResult[]);
    });

    // Passed over stdin, not argv: a few hundred entries easily exceed
    // Windows' ~32k command-line limit.
    child.stdin.end(JSON.stringify({ databasePath, entries }));
  });
}

export async function exportSessionFilesBatched(
  databasePath: string,
  entries: BatchExportEntry[]
): Promise<BatchExportResult[]> {
  if (entries.length === 0) {
    return [];
  }

  let DatabaseSync: new (p: string, o?: Record<string, unknown>) => ExportHandle;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return entries.map((entry) => ({ sessionId: entry.sessionId, ok: false as const, error: 'node:sqlite unavailable (needs Node 22.5+).' }));
  }

  let source: ExportHandle;
  try {
    source = new DatabaseSync(databasePath, { readOnly: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return entries.map((entry) => ({ sessionId: entry.sessionId, ok: false as const, error }));
  }

  const results: BatchExportResult[] = [];
  try {
    for (let offset = 0; offset < entries.length; offset += EXPORT_CHUNK_SIZE) {
      const chunk = entries.slice(offset, offset + EXPORT_CHUNK_SIZE);
      results.push(...(await exportChunk(DatabaseSync, source, chunk)));
    }
  } finally {
    try {
      source.close();
    } catch {
      // ignore
    }
  }

  return results;
}

async function exportChunk(
  DatabaseSync: new (p: string, o?: Record<string, unknown>) => ExportHandle,
  source: ExportHandle,
  chunk: BatchExportEntry[]
): Promise<BatchExportResult[]> {
  const sessionIds = chunk.map((entry) => entry.sessionId);

  // One read per table for the whole chunk, grouped by session in memory.
  const grouped = new Map<string, Map<string, Record<string, unknown>[]>>();
  const schema = new Map<string, { createSql: string; columns: string[] }>();
  for (const id of sessionIds) {
    grouped.set(id, new Map());
  }

  for (const table of SESSION_TABLES) {
    const tableSchema = readTableSchema(source, table.name);
    if (!tableSchema) {
      continue; // Table doesn't exist in this schema generation.
    }
    schema.set(table.name, tableSchema);

    const placeholders = sessionIds.map(() => '?').join(', ');
    const columnList = tableSchema.columns.map(quoteIdent).join(', ');
    let rows: Record<string, unknown>[];
    try {
      rows = source
        .prepare(
          `SELECT ${columnList} FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.sessionIdColumn)} IN (${placeholders})`
        )
        .all(...sessionIds);
    } catch {
      continue;
    }

    for (const row of rows) {
      const owner = String(row[table.sessionIdColumn] ?? '');
      const perSession = grouped.get(owner);
      if (!perSession) {
        continue;
      }
      const list = perSession.get(table.name);
      if (list) {
        list.push(row);
      } else {
        perSession.set(table.name, [row]);
      }
    }
  }

  // The project row isn't keyed by session id; fetch the few that are
  // referenced rather than scanning per session.
  const projectSchema = readTableSchema(source, 'project');
  const projectRows = new Map<string, Record<string, unknown>>();
  if (projectSchema) {
    const projectIds = new Set<string>();
    for (const perSession of grouped.values()) {
      for (const row of perSession.get('session') ?? []) {
        if (typeof row.project_id === 'string') {
          projectIds.add(row.project_id);
        }
      }
    }
    if (projectIds.size > 0) {
      const ids = [...projectIds];
      try {
        const rows = source
          .prepare(
            `SELECT ${projectSchema.columns.map(quoteIdent).join(', ')} FROM "project" WHERE "id" IN (${ids
              .map(() => '?')
              .join(', ')})`
          )
          .all(...ids);
        for (const row of rows) {
          projectRows.set(String(row.id), row);
        }
      } catch {
        // A missing/unreadable project table is not fatal — the session
        // still exports, it just arrives without its directory metadata.
      }
    }
  }

  const results: BatchExportResult[] = [];
  for (const entry of chunk) {
    const perSession = grouped.get(entry.sessionId) ?? new Map();
    if ((perSession.get('session') ?? []).length === 0) {
      results.push({
        sessionId: entry.sessionId,
        ok: false,
        error: `session ${entry.sessionId} not found in opencode.db on this machine`,
      });
      continue;
    }

    const tmpPath = scratchPathFor(entry.outputPath);
    let output: ExportHandle | undefined;
    try {
      await fs.promises.rm(tmpPath, { force: true });
      output = new DatabaseSync(tmpPath);

      let rows = 0;

      const sessionRow = perSession.get('session')![0];
      if (projectSchema && typeof sessionRow.project_id === 'string') {
        const projectRow = projectRows.get(sessionRow.project_id);
        if (projectRow) {
          rows += writeRows(output, 'project', projectSchema, [projectRow]);
        }
      }

      for (const table of SESSION_TABLES) {
        const tableSchema = schema.get(table.name);
        if (!tableSchema) {
          continue;
        }
        rows += writeRows(output, table.name, tableSchema, perSession.get(table.name) ?? []);
      }

      output.close();
      output = undefined;
      await moveIntoPlace(tmpPath, entry.outputPath);
      results.push({ sessionId: entry.sessionId, ok: true, rows });
    } catch (err) {
      results.push({ sessionId: entry.sessionId, ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      try {
        output?.close();
      } catch {
        // ignore
      }
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  return results;
}

function readTableSchema(source: ExportHandle, table: string): { createSql: string; columns: string[] } | null {
  try {
    const createSql = source
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)?.sql;
    if (typeof createSql !== 'string') {
      return null;
    }
    const columns = source
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all()
      .map((row) => String(row.name));
    return columns.length > 0 ? { createSql, columns } : null;
  } catch {
    return null;
  }
}

/** Recreates `table` in `output` from the source's own CREATE TABLE statement and inserts `rows`. */
function writeRows(
  output: ExportHandle,
  table: string,
  schema: { createSql: string; columns: string[] },
  rows: Record<string, unknown>[]
): number {
  output.exec(schema.createSql);
  if (rows.length === 0) {
    return 0;
  }
  const columnList = schema.columns.map(quoteIdent).join(', ');
  const insert = output.prepare(
    `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${schema.columns.map(() => '?').join(', ')})`
  );
  output.exec('BEGIN;');
  try {
    for (const row of rows) {
      insert.run(...schema.columns.map((c) => row[c]));
    }
    output.exec('COMMIT;');
  } catch (err) {
    try {
      output.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }
  return rows.length;
}

export async function exportFavoriteSessionFile(
  databasePath: string,
  sessionId: string,
  outputPath: string
): Promise<ExportResult> {
  let DatabaseSync: new (p: string, o?: Record<string, unknown>) => ExportHandle;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { ok: false, error: 'node:sqlite unavailable (needs Node 22.5+).' };
  }

  let source: ExportHandle | undefined;
  let output: ExportHandle | undefined;
  const tmpPath = scratchPathFor(outputPath);

  try {
    source = new DatabaseSync(databasePath, { readOnly: true });

    const sessionRow = source.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
    if (!sessionRow) {
      return { ok: false, error: `session ${sessionId} not found in opencode.db on this machine` };
    }

    await fs.promises.rm(tmpPath, { force: true });
    output = new DatabaseSync(tmpPath);

    let rows = 0;

    // The project row isn't keyed by session id, but carrying it along means
    // the restored session has a real directory to resolve on the other
    // machine, same as any other cross-machine session already does.
    const projectId = sessionRow.project_id;
    if (typeof projectId === 'string') {
      rows += copyMatchingRows(source, output, 'project', 'id', projectId);
    }

    for (const table of SESSION_TABLES) {
      rows += copyMatchingRows(source, output, table.name, table.sessionIdColumn, sessionId);
    }

    output.close();
    output = undefined;
    await moveIntoPlace(tmpPath, outputPath);

    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      source?.close();
    } catch {
      // ignore
    }
    try {
      output?.close();
    } catch {
      // ignore
    }
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

/** Recreates `table` in `output` (via the source's own CREATE TABLE statement) and copies rows matching `keyColumn = keyValue`. */
function copyMatchingRows(
  source: ExportHandle,
  output: ExportHandle,
  table: string,
  keyColumn: string,
  keyValue: string
): number {
  const createSql = source.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql;
  if (typeof createSql !== 'string') {
    return 0; // Table doesn't exist in this schema generation — nothing to copy.
  }
  output.exec(createSql);

  const columns = source
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .map((row) => String(row.name));
  const columnList = columns.map(quoteIdent).join(', ');

  const rows = source
    .prepare(`SELECT ${columnList} FROM ${quoteIdent(table)} WHERE ${quoteIdent(keyColumn)} = ?`)
    .all(keyValue);
  if (rows.length === 0) {
    return 0;
  }

  const insert = output.prepare(
    `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${columns.map(() => '?').join(', ')})`
  );
  for (const row of rows) {
    insert.run(...columns.map((c) => row[c]));
  }
  return rows.length;
}

/** Table/column names here always come from PRAGMA table_info / sqlite_master of OpenCode's own schema, never external input — quoting only guards against reserved words. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
