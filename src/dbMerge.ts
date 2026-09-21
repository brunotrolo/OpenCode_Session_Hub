/**
 * opencode.db is a single binary SQLite file, so a plain `git merge` treats
 * two machines' independent writes to it as an unresolvable binary conflict —
 * forcing "keep local" or "keep remote" and silently discarding every session
 * the other machine created since the last sync. This module merges the two
 * database files at the row level instead: each table's rows are unioned by
 * id, with the newer `time_updated` winning on an actual id collision. That
 * turns what used to be "lose one machine's history" into "no conflict at
 * all" for the overwhelming majority of cases, since two machines create
 * disjoint sessions/messages/parts far more often than they edit the same row.
 */

interface SqliteHandle {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): void;
  };
  exec(sql: string): void;
  close(): void;
}

/** Every table in opencode.db worth merging; each has both time columns per OpenCode's own schema. */
const MERGE_TABLES = ['project', 'session', 'message', 'part'];
const UPDATED_COLUMN_CANDIDATES = ['time_updated', 'time_created'];

/**
 * Merges `sourcePath`'s rows into `targetPath` in place (target is mutated,
 * source is only read). Returns the number of rows inserted or updated, or
 * `null` — without throwing — if `node:sqlite` isn't available (Node < 22.5,
 * e.g. an older VS Code build) or either file isn't a readable SQLite
 * database, so callers can fall back to the old whole-file behavior. `0` is a
 * meaningful, distinct result: the merge ran but found nothing new, which
 * callers rely on to avoid reporting a no-op merge as a real sync change.
 */
export function mergeSessionDatabases(targetPath: string, sourcePath: string): number | null {
  let DatabaseSync: new (p: string, o?: Record<string, unknown>) => SqliteHandle;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }

  let target: SqliteHandle | undefined;
  let source: SqliteHandle | undefined;
  try {
    target = new DatabaseSync(targetPath);
    source = new DatabaseSync(sourcePath, { readOnly: true });

    let changed = 0;
    target.exec('BEGIN;');
    try {
      for (const table of MERGE_TABLES) {
        changed += mergeTable(target, source, table);
      }
      target.exec('COMMIT;');
    } catch (err) {
      try {
        target.exec('ROLLBACK;');
      } catch {
        // Best-effort: if rollback itself fails the connection is already in a bad state.
      }
      throw err;
    }
    return changed;
  } catch {
    return null;
  } finally {
    try {
      source?.close();
    } catch {
      // ignore
    }
    try {
      target?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Merges many source databases into one target in a SINGLE target
 * connection. Calling mergeSessionDatabases() in a loop instead reopens and
 * recloses the target once per source — and on OpenCode's real multi-GB
 * opencode.db each close triggers a WAL checkpoint, so merging a few hundred
 * per-session export files that way turns a pull into a long synchronous
 * stall of the whole extension host. Returns per-source results in the same
 * order as `sourcePaths`, so one unreadable export still reports individually
 * without failing the rest, or `null` if the target itself can't be opened.
 */
export function mergeManySessionDatabases(
  targetPath: string,
  sourcePaths: string[]
): { path: string; changed: number | null }[] | null {
  let DatabaseSync: new (p: string, o?: Record<string, unknown>) => SqliteHandle;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }

  let target: SqliteHandle | undefined;
  try {
    target = new DatabaseSync(targetPath);
  } catch {
    return null;
  }

  const results: { path: string; changed: number | null }[] = [];
  try {
    for (const sourcePath of sourcePaths) {
      let source: SqliteHandle | undefined;
      try {
        source = new DatabaseSync(sourcePath, { readOnly: true });
        let changed = 0;
        target.exec('BEGIN;');
        try {
          for (const table of MERGE_TABLES) {
            changed += mergeTable(target, source, table);
          }
          target.exec('COMMIT;');
        } catch (err) {
          try {
            target.exec('ROLLBACK;');
          } catch {
            // Best-effort: if rollback itself fails the connection is already in a bad state.
          }
          throw err;
        }
        results.push({ path: sourcePath, changed });
      } catch {
        results.push({ path: sourcePath, changed: null });
      } finally {
        try {
          source?.close();
        } catch {
          // ignore
        }
      }
    }
  } finally {
    try {
      target.close();
    } catch {
      // ignore
    }
  }

  return results;
}

function mergeTable(target: SqliteHandle, source: SqliteHandle, table: string): number {
  let targetColumns: string[];
  let sourceColumns: string[];
  try {
    targetColumns = tableColumns(target, table);
    sourceColumns = tableColumns(source, table);
  } catch {
    return 0;
  }
  if (targetColumns.length === 0 || sourceColumns.length === 0) {
    // Table missing on one side (older/newer OpenCode schema) — nothing safe to merge.
    return 0;
  }

  const columns = targetColumns.filter((c) => sourceColumns.includes(c));
  if (!columns.includes('id')) {
    return 0;
  }
  const updatedColumn = UPDATED_COLUMN_CANDIDATES.find((c) => columns.includes(c));

  const columnList = columns.map(quoteIdent).join(', ');
  const nonIdColumns = columns.filter((c) => c !== 'id');
  const getExisting = target.prepare(`SELECT ${columnList} FROM ${quoteIdent(table)} WHERE id = ?`);
  const insert = target.prepare(
    `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${columns.map(() => '?').join(', ')})`
  );
  const update = nonIdColumns.length
    ? target.prepare(
        `UPDATE ${quoteIdent(table)} SET ${nonIdColumns.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE id = ?`
      )
    : undefined;

  let changed = 0;
  const sourceRows = source.prepare(`SELECT ${columnList} FROM ${quoteIdent(table)}`).all();
  for (const row of sourceRows) {
    const existing = getExisting.get(row.id);
    if (!existing) {
      insert.run(...columns.map((c) => row[c]));
      changed++;
      continue;
    }
    if (!updatedColumn || !update) {
      continue; // No timestamp to arbitrate and the row already exists: keep target's copy.
    }
    const existingUpdated = Number(existing[updatedColumn] ?? 0);
    const incomingUpdated = Number(row[updatedColumn] ?? 0);
    if (incomingUpdated > existingUpdated) {
      update.run(...nonIdColumns.map((c) => row[c]), row.id);
      changed++;
    }
  }
  return changed;
}

function tableColumns(db: SqliteHandle, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .map((row) => String(row.name));
}

/** Table/column names here always come from PRAGMA table_info of OpenCode's own schema, never external input — quoting only guards against reserved words. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
