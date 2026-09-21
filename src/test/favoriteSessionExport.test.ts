import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { mergeSessionDatabases } from '../dbMerge';
import { exportFavoriteSessionFile } from '../favoriteSessionExport';
import { addSqliteSession, createMachine, FakeMachine } from './fixtures';

describe('exportFavoriteSessionFile', () => {
  let root: string;
  let machine: FakeMachine;
  let dbPath: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-favexport-'));
    machine = createMachine(root, 'work');
    dbPath = path.join(machine.dataRoot, 'opencode.db');

    addSqliteSession(machine, {
      sessionId: 'ses_keep',
      projectId: 'prj_a',
      title: 'Keep this one',
      directory: '/work/keep',
      updated: 1_700_000_000_000,
      messages: [{ id: 'msg_keep', role: 'user', text: 'remember this', created: 1_700_000_000_000 }],
    });
    addSqliteSession(machine, {
      sessionId: 'ses_other',
      projectId: 'prj_a',
      title: 'Not favorited',
      directory: '/work/other',
      updated: 1_700_000_100_000,
      messages: [{ id: 'msg_other', role: 'user', text: 'not this one', created: 1_700_000_100_000 }],
    });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('exports only the requested session\'s rows, not every session in the database', async () => {
    const outputPath = path.join(root, 'ses_keep.db');
    const result = await exportFavoriteSessionFile(dbPath, 'ses_keep', outputPath);
    assert.ok(result.ok, result.ok ? '' : result.error);
    assert.ok(fs.existsSync(outputPath));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const exported = new DatabaseSync(outputPath, { readOnly: true });
    try {
      const sessions = exported.prepare('SELECT id FROM session').all();
      assert.deepStrictEqual(
        sessions.map((s: { id: string }) => s.id),
        ['ses_keep']
      );
      const messages = exported.prepare('SELECT id FROM message').all();
      assert.deepStrictEqual(
        messages.map((m: { id: string }) => m.id),
        ['msg_keep']
      );
    } finally {
      exported.close();
    }
  });

  it('produces a file mergeSessionDatabases can apply directly into another opencode.db', async () => {
    const outputPath = path.join(root, 'ses_keep_for_merge.db');
    await exportFavoriteSessionFile(dbPath, 'ses_keep', outputPath);

    const otherMachine = createMachine(root, 'home');
    const otherDbPath = path.join(otherMachine.dataRoot, 'opencode.db');
    addSqliteSession(otherMachine, {
      sessionId: 'ses_home_only',
      projectId: 'prj_b',
      title: "Home's own session",
      directory: '/home/mine',
      updated: 1_700_000_200_000,
    });

    const merged = mergeSessionDatabases(otherDbPath, outputPath);
    assert.ok(merged !== null && merged > 0, `expected rows to merge, got ${merged}`);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(otherDbPath, { readOnly: true });
    try {
      const ids = db
        .prepare('SELECT id FROM session ORDER BY id')
        .all()
        .map((s: { id: string }) => s.id);
      assert.deepStrictEqual(ids, ['ses_home_only', 'ses_keep']);
    } finally {
      db.close();
    }
  });

  it('reports a clear error for a session id that does not exist locally, without throwing', async () => {
    const outputPath = path.join(root, 'ses_missing.db');
    const result = await exportFavoriteSessionFile(dbPath, 'ses_does_not_exist', outputPath);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.includes('ses_does_not_exist'));
    }
    assert.ok(!fs.existsSync(outputPath), 'no partial file should be left behind');
  });

  it('reports a clear error for a database that does not exist, without throwing', async () => {
    const outputPath = path.join(root, 'ses_no_db.db');
    const result = await exportFavoriteSessionFile(path.join(root, 'does-not-exist.db'), 'ses_keep', outputPath);
    assert.strictEqual(result.ok, false);
  });
});
