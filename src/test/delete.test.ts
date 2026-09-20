import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { addFavorite, loadFavorites } from '../favorites';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { deleteSession, loadMessages, scanSessions } from '../sessionScanner';
import { addLegacySession, addSqliteSession, addStorageSession, createMachine, FakeMachine } from './fixtures';

describe('deleting a session', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-delete-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('removes a storage-json session, its messages and its parts', () => {
    const machine = createMachine(root, 'storage-json');
    addStorageSession(machine, {
      projectId: 'prj_a',
      sessionId: 'ses_to_delete',
      title: 'Delete me',
      worktree: '/work/demo',
      messages: [{ id: 'msg_1', role: 'user', text: 'hello', created: 1_700_000_000_000 }],
    });
    // A sibling session must survive untouched.
    addStorageSession(machine, {
      projectId: 'prj_a',
      sessionId: 'ses_keep',
      title: 'Keep me',
      worktree: '/work/demo',
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const target = scanSessions(locations).sessions.find((s) => s.id === 'ses_to_delete')!;

    deleteSession(locations, target);

    const remaining = scanSessions(locations).sessions.map((s) => s.id);
    assert.deepStrictEqual(remaining, ['ses_keep']);
    assert.ok(!fs.existsSync(path.join(machine.dataRoot, 'storage', 'session', 'prj_a', 'ses_to_delete.json')));
    assert.ok(!fs.existsSync(path.join(machine.dataRoot, 'storage', 'message', 'ses_to_delete')));
    assert.ok(!fs.existsSync(path.join(machine.dataRoot, 'storage', 'part', 'msg_1')));
  });

  it('removes a legacy-json session, its messages and its parts', () => {
    const machine = createMachine(root, 'legacy-json');
    addLegacySession(machine, {
      projectDir: 'legacy-project',
      sessionId: 'ses_legacy_delete',
      title: 'Old session',
      directory: '/legacy/app',
      messages: [{ id: 'msg_l1', role: 'user', text: 'legacy text', created: 1_600_000_000_000 }],
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const target = scanSessions(locations).sessions.find((s) => s.id === 'ses_legacy_delete')!;

    deleteSession(locations, target);

    assert.deepStrictEqual(scanSessions(locations).sessions, []);
    const base = path.join(machine.dataRoot, 'project', 'legacy-project', 'storage', 'session');
    assert.ok(!fs.existsSync(path.join(base, 'info', 'ses_legacy_delete.json')));
    assert.ok(!fs.existsSync(path.join(base, 'message', 'ses_legacy_delete')));
    assert.ok(!fs.existsSync(path.join(base, 'part', 'ses_legacy_delete')));
  });

  it('removes a sqlite session, its messages and its parts', () => {
    const machine = createMachine(root, 'sqlite');
    addSqliteSession(machine, {
      sessionId: 'ses_sql_delete',
      projectId: 'prj_sql',
      title: 'SQL session',
      directory: '/sql/app',
      updated: 1_700_000_000_000,
      messages: [{ id: 'msg_s1', role: 'user', text: 'sql text', created: 1_700_000_000_000 }],
    });
    addSqliteSession(machine, {
      sessionId: 'ses_sql_keep',
      projectId: 'prj_sql',
      title: 'SQL keep',
      directory: '/sql/app',
      updated: 1_700_000_100_000,
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const target = scanSessions(locations).sessions.find((s) => s.id === 'ses_sql_delete')!;

    deleteSession(locations, target);

    const remaining = scanSessions(locations).sessions;
    assert.deepStrictEqual(remaining.map((s) => s.id), ['ses_sql_keep']);
    assert.strictEqual(loadMessages(locations, target).length, 0);
  });

  it('does not throw when the underlying files are already gone', () => {
    const machine = createMachine(root, 'already-gone');
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    assert.doesNotThrow(() =>
      deleteSession(locations, {
        id: 'ses_never_existed',
        title: 'Ghost',
        directory: '/nowhere',
        projectId: 'prj_x',
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0,
        source: 'storage-json',
      })
    );
  });

  it('via SyncController, also drops any favorite bookmarking the deleted session', async () => {
    const machine = createMachine(root, 'with-favorite');
    addStorageSession(machine, {
      projectId: 'prj_b',
      sessionId: 'ses_favorited',
      title: 'Favorited then deleted',
      worktree: '/work/fav',
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    addFavorite(locations, 'my bookmark', 'ses_favorited');
    assert.strictEqual(loadFavorites(locations).length, 1);

    const stub = require('./vscodeStub').installVscodeStub();
    stub.config['dataPath'] = machine.dataRoot;
    process.env.opencode_config_dir = machine.configRoot;
    try {
      const { SyncController } = require('../syncController');
      const controller = new SyncController(
        { globalStorageUri: { fsPath: path.join(machine.home, 'globalStorage') } },
        { appendLine: () => undefined, dispose: () => undefined }
      );

      const target = scanSessions(locations).sessions.find((s) => s.id === 'ses_favorited')!;
      controller.deleteSession(target);

      assert.deepStrictEqual(scanSessions(locations).sessions, []);
      assert.deepStrictEqual(loadFavorites(locations), []);
    } finally {
      delete process.env.opencode_config_dir;
    }
  });
});
