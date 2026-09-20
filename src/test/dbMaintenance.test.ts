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

  it('reports a clear error for a database that does not exist', async () => {
    const result = await vacuumDatabase(path.join(root, 'does-not-exist.db'));
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.includes('does not exist'));
    }
  });
});
