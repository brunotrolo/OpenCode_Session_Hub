import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { SyncManager, SyncSettings } from '../syncManager';
import { addFavorite } from '../favorites';
import { addSqliteSession, createMachine, FakeMachine } from './fixtures';

/**
 * Scenario tests reproducing the real production setup this extension keeps
 * failing on: a Windows machine whose opencode.db has grown past the sync
 * size limit, where the user's actual complaint is that sessions never reach
 * GitHub at all. These drive the real push pipeline against a real bare git
 * repo and assert on what actually lands in the remote — not on internal
 * state — because every bug reported so far has been the pipeline silently
 * declining to sync something while reporting success.
 */
describe('real-world sync scenarios', () => {
  let root: string;

  const settingsFor = (machine: FakeMachine, remote: string, overrides: Partial<SyncSettings> = {}): SyncSettings => ({
    remoteUrl: remote,
    branch: 'main',
    repoDir: path.join(machine.home, 'sync-repo'),
    includeSecrets: true,
    includeSessions: true,
    includeModelFavorites: true,
    includeOpencodeSkills: true,
    includeAgentsDir: true,
    redactSecrets: true,
    privateRepoAcknowledged: true,
    ...overrides,
  });

  const makeRemote = (name: string): string => {
    const remote = path.join(root, `${name}.git`);
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    return remote;
  };

  /** Files actually committed on the remote's main branch. */
  const remoteFiles = (remote: string): string[] => {
    const result = spawnSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: remote, encoding: 'utf8' });
    return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  };

  /** Grows opencode.db past the oversized-skip limit, as the real 7GB database is. */
  const bloatDatabase = (machine: FakeMachine, bytes: number): void => {
    const dbPath = path.join(machine.dataRoot, 'opencode.db');
    const handle = fs.openSync(dbPath, 'r+');
    try {
      fs.ftruncateSync(handle, bytes);
    } finally {
      fs.closeSync(handle);
    }
  };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-scenario-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('still gets a favorited session to the remote when opencode.db is over the size limit', async () => {
    // THE production scenario: the whole-database sync is permanently
    // skipped as oversized, so the per-session favorite export is the only
    // path session history has to the remote. If this doesn't land a file,
    // the user's sessions never reach GitHub — which is exactly the report.
    const remote = makeRemote('oversized');
    const machine = createMachine(root, 'oversized');
    addSqliteSession(machine, {
      sessionId: 'ses_favorited',
      projectId: 'prj',
      title: 'Important session',
      directory: '/work/app',
      updated: 1_700_000_000_000,
      messages: [{ id: 'msg_1', role: 'user', text: 'keep this', created: 1_700_000_000_000 }],
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    addFavorite(locations, 'important', 'ses_favorited');
    bloatDatabase(machine, 95 * 1024 * 1024);

    const outcome = await new SyncManager(locations, settingsFor(machine, remote)).push();

    assert.strictEqual(outcome.status, 'ok', `push failed: ${outcome.messages.join(' | ')}`);
    const files = remoteFiles(remote);
    assert.ok(
      files.includes('data/favorite-sessions/ses_favorited.db'),
      `favorited session never reached the remote. Files: ${JSON.stringify(files)} Messages: ${outcome.messages.join(' | ')}`
    );
    assert.ok(
      !files.includes('data/opencode.db'),
      'the oversized database should have been skipped, not pushed'
    );
  });

  it('syncs unfavorited sessions individually when the database is too big to sync as a whole', async () => {
    // The actual production failure: a multi-GB opencode.db is permanently
    // skipped, and if per-session export only covered favorites, a user who
    // never bookmarked anything syncs config forever while not one session
    // reaches GitHub — with every push reporting success. Sessions must get
    // across on their own when the whole-database route is unavailable.
    const remote = makeRemote('nothing-to-sync');
    const machine = createMachine(root, 'nothing-to-sync');
    for (const id of ['ses_unfavorited_a', 'ses_unfavorited_b']) {
      addSqliteSession(machine, {
        sessionId: id,
        projectId: 'prj',
        title: `Not favorited ${id}`,
        directory: '/work/app',
        updated: 1_700_000_000_000,
        messages: [{ id: `msg_${id}`, role: 'user', text: 'text', created: 1_700_000_000_000 }],
      });
    }
    bloatDatabase(machine, 95 * 1024 * 1024);

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const outcome = await new SyncManager(locations, settingsFor(machine, remote)).push();

    assert.strictEqual(outcome.status, 'ok', `push failed: ${outcome.messages.join(' | ')}`);
    const files = remoteFiles(remote);
    for (const id of ['ses_unfavorited_a', 'ses_unfavorited_b']) {
      assert.ok(
        files.includes(`data/favorite-sessions/${id}.db`),
        `unfavorited session ${id} never reached the remote. Files: ${JSON.stringify(files)} Messages: ${outcome.messages.join(' | ')}`
      );
    }
  });

  it('tells the user session history is being skipped when the secrets gate is off', async () => {
    // includeSecrets/privateRepoAcknowledged default to OFF, and session
    // history counts as secret data — so a user who never found those
    // checkboxes syncs config happily forever while no session ever moves.
    const remote = makeRemote('gate-off');
    const machine = createMachine(root, 'gate-off');
    addSqliteSession(machine, {
      sessionId: 'ses_gated',
      projectId: 'prj',
      title: 'Gated session',
      directory: '/work/app',
      updated: 1_700_000_000_000,
      messages: [{ id: 'msg_1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    addFavorite(locations, 'gated', 'ses_gated');
    const outcome = await new SyncManager(
      locations,
      settingsFor(machine, remote, { includeSecrets: false, privateRepoAcknowledged: false })
    ).push();

    const combined = outcome.messages.join(' | ');
    assert.ok(
      /includeSecrets/i.test(combined),
      `expected an explicit warning naming the setting to turn on. Got: ${combined}`
    );
    assert.ok(
      !remoteFiles(remote).some((f) => f.startsWith('data/favorite-sessions/')),
      'favorited sessions must not bypass the secrets gate'
    );
  });

  it('still exports favorited sessions while OpenCode is running (a -wal file is present)', async () => {
    // The user's daily reality: OpenCode is open, so opencode.db has an
    // active -wal alongside it. The whole-database mirror deliberately skips
    // in that state ("close OpenCode and sync again"), but a favorite export
    // reads one session read-only and must NOT be blocked by the same check
    // — otherwise sessions only ever sync when OpenCode is closed, which is
    // effectively never.
    const remote = makeRemote('wal-present');
    const machine = createMachine(root, 'wal-present');
    addSqliteSession(machine, {
      sessionId: 'ses_live',
      projectId: 'prj',
      title: 'Live session',
      directory: '/work/app',
      updated: 1_700_000_000_000,
      messages: [{ id: 'msg_l1', role: 'user', text: 'written while running', created: 1_700_000_000_000 }],
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    addFavorite(locations, 'live', 'ses_live');

    // Hold an open connection in WAL mode with an uncheckpointed write, the
    // way a running OpenCode does.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const holder = new DatabaseSync(path.join(machine.dataRoot, 'opencode.db'));
    holder.exec('PRAGMA journal_mode=WAL;');
    holder.exec("INSERT INTO message VALUES ('msg_live_2', 'ses_live', 1700000000001, 1700000000001, '{}');");

    try {
      const outcome = await new SyncManager(locations, settingsFor(machine, remote)).push();
      assert.strictEqual(outcome.status, 'ok', `push failed: ${outcome.messages.join(' | ')}`);
      assert.ok(
        remoteFiles(remote).includes('data/favorite-sessions/ses_live.db'),
        `favorite export must work while OpenCode holds the database open. Messages: ${outcome.messages.join(' | ')}`
      );
    } finally {
      holder.close();
    }
  });

  it('exports a favorited session out of a database with a large message/part table without stalling', async () => {
    // copyMatchingRows filters part/message by session_id, which OpenCode's
    // schema does not index — on the real multi-GB database that's a full
    // table scan per favorite, run synchronously during a push. This guards
    // the correctness and the cost at a scale where a regression would show.
    const machine = createMachine(root, 'big-export');
    const dbPath = path.join(machine.dataRoot, 'opencode.db');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT,
               time_created INTEGER, time_updated INTEGER, sandboxes TEXT)`);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
               slug TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT,
               time_created INTEGER, time_updated INTEGER)`);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
               time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
               time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`);
    db.prepare('INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)').run('prj', '/work', 'git', 1, 1, '[]');

    const insertSession = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN;');
    for (let s = 0; s < 80; s++) {
      insertSession.run(`ses_${s}`, 'prj', null, 'slug', '/work', `Session ${s}`, '1.0.0', 1, 1);
      for (let m = 0; m < 40; m++) {
        insertMessage.run(`msg_${s}_${m}`, `ses_${s}`, 1, 1, '{}');
        insertPart.run(`prt_${s}_${m}`, `msg_${s}_${m}`, `ses_${s}`, 1, 1, '{}');
      }
    }
    db.exec('COMMIT;');
    db.close();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { exportFavoriteSessionFile } = require('../favoriteSessionExport');
    const outputPath = path.join(machine.home, 'export.db');
    const start = Date.now();
    const result = await exportFavoriteSessionFile(dbPath, 'ses_40', outputPath);
    const elapsedMs = Date.now() - start;

    assert.ok(result.ok, `export failed: ${result.ok ? '' : result.error}`);
    // 1 project + 1 session + 40 messages + 40 parts
    assert.strictEqual(result.rows, 82);
    assert.ok(elapsedMs < 5000, `export should stay fast; took ${elapsedMs}ms`);

    const exported = new DatabaseSync(outputPath, { readOnly: true });
    try {
      const count = exported.prepare('SELECT COUNT(*) AS n FROM part').get();
      assert.strictEqual(Number(count.n), 40, 'only the favorited session\'s parts belong in the export');
    } finally {
      exported.close();
    }
  });

  it('carries many individually-exported sessions to a second machine in one pull', async () => {
    // With the whole database skipped, a push can now export a few hundred
    // sessions as separate files. The pull side must merge them all into the
    // receiving machine's opencode.db — and do it without reopening that
    // (potentially multi-GB) database once per file.
    const remote = makeRemote('many-sessions');
    const alice = createMachine(root, 'alice-many');
    const bob = createMachine(root, 'bob-many');

    const sessionIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `ses_many_${i}`;
      sessionIds.push(id);
      addSqliteSession(alice, {
        sessionId: id,
        projectId: 'prj',
        title: `Session ${i}`,
        directory: '/work/app',
        updated: 1_700_000_000_000 + i,
        messages: [{ id: `msg_${id}`, role: 'user', text: `content ${i}`, created: 1_700_000_000_000 + i }],
      });
    }

    const aliceLocations = resolveOpenCodeLocations(alice.env, 'linux');
    bloatDatabase(alice, 95 * 1024 * 1024);
    const pushOutcome = await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();
    assert.strictEqual(pushOutcome.status, 'ok', `push failed: ${pushOutcome.messages.join(' | ')}`);

    const bobLocations = resolveOpenCodeLocations(bob.env, 'linux');
    const pullOutcome = await new SyncManager(bobLocations, settingsFor(bob, remote)).pull();
    assert.strictEqual(pullOutcome.status, 'ok', `pull failed: ${pullOutcome.messages.join(' | ')}`);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { scanSessions, loadMessages } = require('../sessionScanner');
    const arrived = scanSessions(bobLocations).sessions;
    const arrivedIds = arrived.map((s: { id: string }) => s.id);
    for (const id of sessionIds) {
      assert.ok(arrivedIds.includes(id), `session ${id} never arrived on bob. Got: ${JSON.stringify(arrivedIds)}`);
    }
    // Content, not just the session row, has to survive the round trip.
    const seven = arrived.find((s: { id: string }) => s.id === 'ses_many_7');
    assert.strictEqual(loadMessages(bobLocations, seven)[0].text, 'content 7');
  });

  it('does not resurrect a locally deleted session on the next pull', async () => {
    // Now that a push can export every session individually, the remote
    // holds a per-session file for each one. Deleting a session locally and
    // then syncing must not merge it straight back from that file —
    // otherwise "Delete" becomes a no-op that silently undoes itself, which
    // is worse than not offering deletion at all.
    const remote = makeRemote('delete-resurrect');
    const machine = createMachine(root, 'delete-resurrect');
    for (const id of ['ses_keep_me', 'ses_delete_me']) {
      addSqliteSession(machine, {
        sessionId: id,
        projectId: 'prj',
        title: id,
        directory: '/work/app',
        updated: 1_700_000_000_000,
        messages: [{ id: `msg_${id}`, role: 'user', text: 'text', created: 1_700_000_000_000 }],
      });
    }
    bloatDatabase(machine, 95 * 1024 * 1024);

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const pushOutcome = await new SyncManager(locations, settingsFor(machine, remote)).push();
    assert.strictEqual(pushOutcome.status, 'ok', `push failed: ${pushOutcome.messages.join(' | ')}`);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { deleteSession, scanSessions } = require('../sessionScanner');
    const target = scanSessions(locations).sessions.find((s: { id: string }) => s.id === 'ses_delete_me');
    await deleteSession(locations, target);
    assert.ok(!scanSessions(locations).sessions.some((s: { id: string }) => s.id === 'ses_delete_me'));

    await new SyncManager(locations, settingsFor(machine, remote)).pull();

    const after = scanSessions(locations).sessions.map((s: { id: string }) => s.id);
    assert.ok(after.includes('ses_keep_me'), 'the undeleted session must survive');
    assert.ok(
      !after.includes('ses_delete_me'),
      `a deleted session came back after pulling. Sessions now: ${JSON.stringify(after)}`
    );
  });

  it('propagates a deletion to the other machine instead of letting it re-seed the session', async () => {
    // Two machines both holding a session: alice deletes it and pushes. Bob
    // must not only stop seeing it — bob must also not push it straight back
    // out of his own copy, which would make the deletion bounce between them
    // forever.
    const remote = makeRemote('delete-propagates');
    const alice = createMachine(root, 'alice-del');
    const bob = createMachine(root, 'bob-del');

    addSqliteSession(alice, {
      sessionId: 'ses_doomed',
      projectId: 'prj',
      title: 'Doomed session',
      directory: '/work/app',
      updated: 1_700_000_000_000,
      messages: [{ id: 'msg_d1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });
    const aliceLocations = resolveOpenCodeLocations(alice.env, 'linux');
    bloatDatabase(alice, 95 * 1024 * 1024);
    await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();

    // Bob picks it up.
    const bobLocations = resolveOpenCodeLocations(bob.env, 'linux');
    await new SyncManager(bobLocations, settingsFor(bob, remote)).pull();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { deleteSession, scanSessions } = require('../sessionScanner');
    assert.ok(
      scanSessions(bobLocations).sessions.some((s: { id: string }) => s.id === 'ses_doomed'),
      'bob should have received the session before it is deleted'
    );

    // Alice deletes and pushes the deletion.
    const doomed = scanSessions(aliceLocations).sessions.find((s: { id: string }) => s.id === 'ses_doomed');
    await deleteSession(aliceLocations, doomed);
    await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();

    // Bob pulls the tombstone, then pushes — and must not resurrect it.
    await new SyncManager(bobLocations, settingsFor(bob, remote)).pull();
    await new SyncManager(bobLocations, settingsFor(bob, remote)).push();
    await new SyncManager(aliceLocations, settingsFor(alice, remote)).pull();

    assert.ok(
      !remoteFiles(remote).includes('data/favorite-sessions/ses_doomed.db'),
      'the deleted session\'s export file must be gone from the remote'
    );
    assert.ok(
      !scanSessions(aliceLocations).sessions.some((s: { id: string }) => s.id === 'ses_doomed'),
      'the deletion must not bounce back to alice from bob'
    );
  });

  it('carries a favorited session all the way to a second machine', async () => {
    // The full round trip that matters to the user: favorite on machine A,
    // push, pull on machine B, and the session is readable there.
    const remote = makeRemote('round-trip');
    const alice = createMachine(root, 'alice');
    const bob = createMachine(root, 'bob');

    addSqliteSession(alice, {
      sessionId: 'ses_travels',
      projectId: 'prj',
      title: 'Travels between machines',
      directory: '/work/app',
      updated: 1_700_000_000_000,
      messages: [{ id: 'msg_t1', role: 'user', text: 'hello from alice', created: 1_700_000_000_000 }],
    });

    const aliceLocations = resolveOpenCodeLocations(alice.env, 'linux');
    addFavorite(aliceLocations, 'travels', 'ses_travels');
    bloatDatabase(alice, 95 * 1024 * 1024);

    const pushOutcome = await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();
    assert.strictEqual(pushOutcome.status, 'ok', `push failed: ${pushOutcome.messages.join(' | ')}`);

    const bobLocations = resolveOpenCodeLocations(bob.env, 'linux');
    const pullOutcome = await new SyncManager(bobLocations, settingsFor(bob, remote)).pull();
    assert.strictEqual(pullOutcome.status, 'ok', `pull failed: ${pullOutcome.messages.join(' | ')}`);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { scanSessions } = require('../sessionScanner');
    const ids = scanSessions(bobLocations).sessions.map((s: { id: string }) => s.id);
    assert.ok(
      ids.includes('ses_travels'),
      `alice's favorited session never materialized on bob. Found: ${JSON.stringify(ids)} Messages: ${pullOutcome.messages.join(' | ')}`
    );
  });
});
