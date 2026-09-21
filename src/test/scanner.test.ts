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

describe('session scanner performance on a large database', () => {
  it('computes message counts for many sessions with a single aggregate query, not one scan per session', () => {
    // Regression guard for a real report: a correlated subquery
    // (`SELECT COUNT(*) FROM message WHERE session_id = s.id` per session
    // row) turned listing sessions into one full table scan PER SESSION —
    // with ~150 sessions and a message table grown into the hundreds of
    // thousands of rows, that blocked the whole extension host for a long
    // time on every dashboard refresh. This doesn't assert query internals
    // (out of reach from here), but building a database at a scale where
    // the old N-scans behavior would be clearly, unmistakably slow, and
    // asserting this stays fast, catches a regression back to it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-scan-perf-'));
    try {
      const machine = createMachine(root, 'work');
      const dbPath = path.join(machine.dataRoot, 'opencode.db');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL,
                 title TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)`);
      db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                 time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`);

      const insertSession = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)');
      const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');

      const sessionCount = 150;
      const messagesPerSession = 50; // 7,500 message rows total — enough for an O(N) scan-per-session to be unmistakably slower
      db.exec('BEGIN;');
      for (let s = 0; s < sessionCount; s++) {
        const sessionId = `ses_${s}`;
        insertSession.run(sessionId, 'prj', '/work', `Session ${s}`, 1_700_000_000_000 + s, 1_700_000_000_000 + s);
        for (let m = 0; m < messagesPerSession; m++) {
          insertMessage.run(`msg_${s}_${m}`, sessionId, 1_700_000_000_000, 1_700_000_000_000, '{}');
        }
      }
      db.exec('COMMIT;');
      db.close();

      const start = Date.now();
      const { sessions } = scanSessions(resolveOpenCodeLocations(machine.env, 'linux'));
      const elapsedMs = Date.now() - start;

      assert.strictEqual(sessions.length, sessionCount);
      assert.ok(
        sessions.every((s) => s.messageCount === messagesPerSession),
        'every session should report its correct message count'
      );
      assert.ok(elapsedMs < 2000, `expected the scan to stay fast; took ${elapsedMs}ms`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads one session\'s messages+parts with two flat queries, not one part scan per message', () => {
    // Regression guard for a real report: loading a single session's parts
    // via a correlated subquery per message turned opening a preview into
    // one full scan of the part table PER MESSAGE — for a long-running
    // session with a couple thousand messages, that hung the whole extension
    // host, and looked to the user like "closing a preview breaks opening
    // the next one" (the freeze just landed on whatever the next click was).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-scan-msgperf-'));
    try {
      const machine = createMachine(root, 'work');
      const dbPath = path.join(machine.dataRoot, 'opencode.db');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL,
                 title TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)`);
      db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                 time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`);
      db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
                 time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`);

      const insertSession = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)');
      const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
      const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');

      insertSession.run('ses_big', 'prj', '/work', 'Big session', 1_700_000_000_000, 1_700_000_000_000);
      // A second, unrelated session's rows share the same tables — the fix
      // must not leak its parts into ses_big's transcript.
      insertSession.run('ses_other', 'prj', '/work', 'Other session', 1_700_000_000_000, 1_700_000_000_000);
      insertMessage.run('msg_other_1', 'ses_other', 1_700_000_000_000, 1_700_000_000_000, JSON.stringify({ role: 'user' }));
      insertPart.run('prt_other_1', 'msg_other_1', 'ses_other', 1_700_000_000_000, 1_700_000_000_000, JSON.stringify({ type: 'text', text: 'not mine' }));

      const messageCount = 2000;
      db.exec('BEGIN;');
      for (let i = 0; i < messageCount; i++) {
        const messageId = `msg_${i}`;
        insertMessage.run(messageId, 'ses_big', 1_700_000_000_000 + i, 1_700_000_000_000 + i, JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant' }));
        insertPart.run(`prt_${i}`, messageId, 'ses_big', 1_700_000_000_000 + i, 1_700_000_000_000 + i, JSON.stringify({ type: 'text', text: `message ${i}` }));
      }
      db.exec('COMMIT;');
      db.close();

      const loc = resolveOpenCodeLocations(machine.env, 'linux');
      const session = scanSessions(loc).sessions.find((s) => s.id === 'ses_big')!;

      const start = Date.now();
      const messages = loadMessages(loc, session);
      const elapsedMs = Date.now() - start;

      assert.strictEqual(messages.length, messageCount);
      assert.strictEqual(messages[0].text, 'message 0');
      assert.strictEqual(messages[messageCount - 1].text, `message ${messageCount - 1}`);
      assert.ok(!messages.some((m) => m.text === 'not mine'));
      assert.ok(elapsedMs < 2000, `expected loading messages to stay fast; took ${elapsedMs}ms`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    // resolveOpenCodeLocations joins with the HOST's native path separator
    // (it only takes a `platform` hint for the win32-vs-not env var lookup,
    // per resolveHomeDir above) — so the expected value must be built the
    // same way, not hardcoded with '/', or this fails on a real Windows box.
    const locations = resolveOpenCodeLocations(
      { HOME: '/home/u', XDG_DATA_HOME: '/data', opencode_config_dir: '/cfg/oc' },
      'linux'
    );
    assert.strictEqual(locations.dataRoot, path.join('/data', 'opencode'));
    assert.strictEqual(locations.configRoot, path.resolve('/cfg/oc'));
  });
});
