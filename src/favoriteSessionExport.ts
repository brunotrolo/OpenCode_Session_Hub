import * as fs from 'fs';
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
  const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    source = new DatabaseSync(databasePath, { readOnly: true });

    const sessionRow = source.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
    if (!sessionRow) {
      return { ok: false, error: `session ${sessionId} not found in opencode.db on this machine` };
    }

    await fs.promises.mkdir(path.dirname(tmpPath), { recursive: true });
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
    await fs.promises.rename(tmpPath, outputPath);

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
