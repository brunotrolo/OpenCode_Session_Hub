import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { vacuumDatabase } from '../dbMaintenance';

describe('vacuumDatabase', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-vacuum-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('does not block the caller\'s event loop while VACUUM runs', async () => {
    // node:sqlite's exec() is fully synchronous; run inline (as this used to
    // be implemented) VACUUM on a large database would freeze the entire
    // extension host for the whole operation — indistinguishable from "the
    // button did nothing." vacuumDatabase() runs the actual work in a
    // separate process specifically to avoid that. A timer that keeps
    // firing on schedule while the vacuum is in flight proves the caller's
    // own event loop was never blocked.
    const dbPath = path.join(root, 'nonblocking.db');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO t (blob) VALUES (?)');
    const filler = 'x'.repeat(65536);
    for (let i = 0; i < 1500; i++) {
      insert.run(filler);
    }
    db.exec('DELETE FROM t WHERE id % 2 = 0');
    db.close();

    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 20);

    try {
      const start = Date.now();
      const result = await vacuumDatabase(dbPath);
      const elapsedMs = Date.now() - start;
      assert.ok(result.ok, result.ok ? '' : result.error);

      // A blocked event loop would report ~0 ticks regardless of how long
      // the operation actually took; a free one ticks roughly once per
      // interval the whole time.
      const expectedMinimumTicks = Math.floor(elapsedMs / 20 / 2); // generous floor, not exact timing
      assert.ok(
        ticks >= Math.min(expectedMinimumTicks, 3),
        `expected the event loop to keep ticking during the vacuum; got ${ticks} ticks over ${elapsedMs}ms`
      );
    } finally {
      clearInterval(timer);
    }
  });

  it('shrinks a database bloated by deleted rows', () => {
    const dbPath = path.join(root, 'bloated.db');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO t (blob) VALUES (?)');
    const filler = 'x'.repeat(4096);
    for (let i = 0; i < 2000; i++) {
      insert.run(filler);
    }
    // Deleting without vacuuming leaves the freed pages in the file as an
    // internal freelist — this is the exact "7 GB db, mostly bloat" shape
    // the real bug report hit, just at a size a test can run quickly.
    db.exec('DELETE FROM t');
    db.close();

    const beforeSize = fs.statSync(dbPath).size;

    return vacuumDatabase(dbPath).then((result) => {
      assert.ok(result.ok, result.ok ? '' : result.error);
      if (!result.ok) {
        return;
      }
      assert.strictEqual(result.beforeBytes, beforeSize);
      assert.ok(
        result.afterBytes < result.beforeBytes,
        `expected VACUUM to shrink the file: ${result.beforeBytes} -> ${result.afterBytes}`
      );
    });
  });

  it('shrinks the WAL back to empty once nothing else has the database open', async () => {
    const dbPath = path.join(root, 'clean-wal.db');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 500; i++) {
      insert.run('x'.repeat(4096));
    }
    // node:sqlite's close() itself checkpoints as the last connection
    // closes, which is exactly the "OpenCode actually closed cleanly" case
    // — proving the happy path still produces a clean, warning-free result
    // once nothing is genuinely holding the file open anymore.
    db.close();

    const result = await vacuumDatabase(dbPath);
    assert.ok(result.ok, result.ok ? '' : result.error);
    if (!result.ok) {
      return;
    }
    assert.strictEqual(result.walAfterBytes, 0);
    assert.strictEqual(result.walWarning, undefined);
  });

  it('warns when the WAL cannot shrink because another connection still has the database open', async () => {
    // The far more likely real-world cause of a stuck multi-GB WAL than a
    // pinned read transaction: OpenCode (or some other process) still has
    // the database open, even completely idle. TRUNCATE checkpoints the
    // content fine (busy=0) but SQLite still won't truncate the file itself
    // while another connection has it mapped — so this has to be detected
    // from the actual post-checkpoint file size, not the pragma's own
    // busy flag (see the pinned-reader test below for the busy!=0 case).
    const dbPath = path.join(root, 'lingering-connection.db');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const lingering = new DatabaseSync(dbPath);
    lingering.exec('PRAGMA journal_mode=WAL;');
    lingering.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = lingering.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 500; i++) {
      insert.run('x'.repeat(4096));
    }

    try {
      const result = await vacuumDatabase(dbPath);
      assert.ok(result.ok, result.ok ? '' : result.error);
      if (result.ok) {
        assert.ok(result.walAfterBytes > 0, 'expected the WAL to remain non-empty while another connection holds it open');
        assert.ok(result.walWarning, 'expected a warning naming the lingering connection');
      }
    } finally {
      lingering.close();
    }
  });

  it('warns instead of failing when a pinned reader prevents the WAL from fully draining', async () => {
    const dbPath = path.join(root, 'pinned-reader.db');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL;');
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    writer.exec("INSERT INTO t (v) VALUES ('one');");

    const reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN;');
    reader.prepare('SELECT * FROM t').all(); // pins this snapshot open

    writer.exec("INSERT INTO t (v) VALUES ('two');"); // a frame the pinned snapshot excludes
    writer.close();

    try {
      const result = await vacuumDatabase(dbPath);
      // VACUUM itself can still succeed even when the checkpoint couldn't
      // fully drain — the warning is informational, not a failure.
      assert.ok(result.ok, result.ok ? '' : result.error);
      if (result.ok) {
        assert.ok(result.walWarning, 'expected a warning about the incomplete checkpoint');
      }
    } finally {
      reader.exec('ROLLBACK;');
      reader.close();
    }
  });

  it('reports a clear error for a database that does not exist', async () => {
    const result = await vacuumDatabase(path.join(root, 'does-not-exist.db'));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.includes('does not exist'));
    }
  });
});
