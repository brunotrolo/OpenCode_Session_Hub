import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { loadMessages, scanSessions } from '../sessionScanner';
import { addLegacySession, addSqliteSession, addStorageSession, createMachine, FakeMachine } from './fixtures';

describe('session scanner across OpenCode storage generations', () => {
  let root: string;
  let machine: FakeMachine;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-scan-'));
    machine = createMachine(root, 'work');

    addStorageSession(machine, {
      projectId: 'prj_alpha',
      sessionId: 'ses_storage1',
      title: 'Refactor billing',
      worktree: '/home/work/billing',
      updated: 1_700_000_900_000,
      messages: [
        { id: 'msg_1', role: 'user', text: 'how do I parse ISO dates', created: 1_700_000_200_000 },
        { id: 'msg_2', role: 'assistant', text: 'use Date.parse', created: 1_700_000_300_000 },
      ],
    });

    addLegacySession(machine, {
      projectDir: 'home-work-legacy',
      sessionId: 'ses_legacy1',
      title: 'Old migration work',
      directory: '/home/work/legacy-app',
      messages: [{ id: 'msg_l1', role: 'user', text: 'legacy regex question', created: 1_600_000_100_000 }],
    });

    addSqliteSession(machine, {
      sessionId: 'ses_sqlite1',
      projectId: 'prj_beta',
      title: 'Database indexing',
      directory: '/home/work/db-tools',
      updated: 1_700_009_000_000,
      messages: [{ id: 'msg_s1', role: 'user', text: 'explain covering indexes', created: 1_700_008_000_000 }],
    });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const locations = () => resolveOpenCodeLocations(machine.env, 'linux');

  it('finds sessions from all three layouts', () => {
    const ids = scanSessions(locations()).sessions.map((s) => s.id);
    assert.deepStrictEqual(ids.sort(), ['ses_legacy1', 'ses_sqlite1', 'ses_storage1']);
  });

  it('sorts newest first', () => {
    const sessions = scanSessions(locations()).sessions;
    assert.strictEqual(sessions[0].id, 'ses_sqlite1');
    assert.strictEqual(sessions[sessions.length - 1].id, 'ses_legacy1');
  });

  it('falls back to the project worktree when the session has no directory', () => {
    const session = scanSessions(locations()).sessions.find((s) => s.id === 'ses_storage1');
    assert.strictEqual(session?.directory, '/home/work/billing');
  });

  it('counts messages per session', () => {
    const sessions = scanSessions(locations()).sessions;
    assert.strictEqual(sessions.find((s) => s.id === 'ses_storage1')?.messageCount, 2);
    assert.strictEqual(sessions.find((s) => s.id === 'ses_sqlite1')?.messageCount, 1);
  });

  it('reads message text out of part files, not message files', () => {
    const loc = locations();
    const storage = scanSessions(loc).sessions.find((s) => s.id === 'ses_storage1')!;
    const messages = loadMessages(loc, storage);
    assert.deepStrictEqual(
      messages.map((m) => m.text),
      ['how do I parse ISO dates', 'use Date.parse']
    );
    assert.deepStrictEqual(
      messages.map((m) => m.role),
      ['user', 'assistant']
    );
  });

  it('reads legacy part files nested under session/message', () => {
    const loc = locations();
    const legacy = scanSessions(loc).sessions.find((s) => s.id === 'ses_legacy1')!;
    assert.strictEqual(loadMessages(loc, legacy)[0].text, 'legacy regex question');
  });

  it('reads SQLite messages by joining the part table', () => {
    const loc = locations();
    const sqlite = scanSessions(loc).sessions.find((s) => s.id === 'ses_sqlite1')!;
    const messages = loadMessages(loc, sqlite);
    assert.strictEqual(messages[0].text, 'explain covering indexes');
    assert.strictEqual(messages[0].role, 'user');
  });

  it('returns empty rather than throwing when nothing is installed', () => {
    const empty = resolveOpenCodeLocations({ HOME: path.join(root, 'nonexistent') }, 'linux');
    assert.deepStrictEqual(scanSessions(empty), { sessions: [], warnings: [] });
  });
});

describe('path resolution', () => {
  it('uses XDG data home on Windows too, not LOCALAPPDATA', () => {
    const locations = resolveOpenCodeLocations(
      { USERPROFILE: 'C:\\Users\\bruno', LOCALAPPDATA: 'C:\\Users\\bruno\\AppData\\Local' },
      'win32'
    );
    assert.ok(locations.dataRoot.includes('.local'));
    assert.ok(!locations.dataRoot.includes('AppData'));
  });

  it('honors XDG_DATA_HOME and opencode_config_dir', () => {
    const locations = resolveOpenCodeLocations(
      { HOME: '/home/u', XDG_DATA_HOME: '/data', opencode_config_dir: '/cfg/oc' },
      'linux'
    );
    assert.strictEqual(locations.dataRoot, '/data/opencode');
    assert.strictEqual(locations.configRoot, '/cfg/oc');
  });
});
