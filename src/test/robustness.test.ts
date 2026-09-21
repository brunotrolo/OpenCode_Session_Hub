import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { SyncManager, SyncSettings } from '../syncManager';
import { loadFavorites, addFavorite } from '../favorites';
import { loadDeletedSessions, markSessionDeleted, clearSessionDeleted } from '../deletedSessions';
import { loadMessages, scanSessions } from '../sessionScanner';
import { addSqliteSession, addStorageSession, createMachine, FakeMachine } from './fixtures';

/**
 * Robustness pass: the states a real machine actually gets into — corrupted
 * files, interrupted syncs, repeated operations, empty and malformed inputs
 * — driven through the real code paths rather than mocked away.
 */
describe('robustness against damaged and unusual local state', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-robust-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('survives a corrupted favorites file instead of breaking the sidebar', () => {
    const machine = createMachine(root, 'corrupt-favorites');
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    fs.mkdirSync(locations.configRoot, { recursive: true });
    fs.writeFileSync(path.join(locations.configRoot, 'opencode-session-hub-favorites.json'), '{not json at all', 'utf8');

    assert.deepStrictEqual(loadFavorites(locations), []);
    // And it must recover: adding one rewrites the file cleanly.
    addFavorite(locations, 'recovered', 'ses_x');
    assert.strictEqual(loadFavorites(locations).length, 1);
  });

  it('survives a corrupted tombstone file', () => {
    const machine = createMachine(root, 'corrupt-tombstones');
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    fs.mkdirSync(locations.configRoot, { recursive: true });
    fs.writeFileSync(
      path.join(locations.configRoot, 'opencode-session-hub-deleted-sessions.json'),
      '[[[garbage',
      'utf8'
    );

    assert.deepStrictEqual(loadDeletedSessions(locations), []);
    markSessionDeleted(locations, 'ses_y');
    assert.deepStrictEqual(
      loadDeletedSessions(locations).map((e) => e.sessionId),
      ['ses_y']
    );
  });

  it('treats marking the same session deleted twice as one tombstone, and can clear it', () => {
    const machine = createMachine(root, 'tombstone-idempotent');
    const locations = resolveOpenCodeLocations(machine.env, 'linux');

    markSessionDeleted(locations, 'ses_dup');
    markSessionDeleted(locations, 'ses_dup');
    assert.strictEqual(loadDeletedSessions(locations).length, 1);

    clearSessionDeleted(locations, 'ses_dup');
    assert.deepStrictEqual(loadDeletedSessions(locations), []);
    // Clearing something that isn't there is a no-op, not an error.
    clearSessionDeleted(locations, 'ses_never');
    assert.deepStrictEqual(loadDeletedSessions(locations), []);
  });

  it('reads sessions from a database that is truncated garbage rather than throwing', () => {
    const machine = createMachine(root, 'corrupt-db');
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    fs.mkdirSync(machine.dataRoot, { recursive: true });
    fs.writeFileSync(locations.databasePath, 'this is definitely not a sqlite file', 'utf8');

    const result = scanSessions(locations);
    assert.deepStrictEqual(result.sessions, []);
    assert.ok(result.warnings.length > 0, 'a damaged database should produce a warning, not silence');
  });

  it('still lists JSON-storage sessions when the SQLite database is unreadable', () => {
    const machine = createMachine(root, 'mixed-broken');
    addStorageSession(machine, {
      projectId: 'prj',
      sessionId: 'ses_json_survives',
      title: 'JSON session',
      worktree: '/work/app',
      messages: [{ id: 'm1', role: 'user', text: 'still here', created: 1_700_000_000_000 }],
    });
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    fs.writeFileSync(locations.databasePath, 'corrupt', 'utf8');

    const ids = scanSessions(locations).sessions.map((s) => s.id);
    assert.ok(
      ids.includes('ses_json_survives'),
      'one broken storage generation must not take the others down with it'
    );
  });

  it('returns no messages rather than throwing for a session that no longer exists', () => {
    const machine = createMachine(root, 'missing-session');
    addSqliteSession(machine, {
      sessionId: 'ses_real',
      projectId: 'prj',
      title: 'Real',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'hi', created: 1_700_000_000_000 }],
    });
    const locations = resolveOpenCodeLocations(machine.env, 'linux');

    const messages = loadMessages(locations, {
      id: 'ses_ghost',
      title: 'Ghost',
      directory: '/work',
      projectId: 'prj',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
      source: 'sqlite',
    });
    assert.deepStrictEqual(messages, []);
  });
});

describe('sync robustness', () => {
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

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-sync-robust-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports no-changes on a second identical push instead of churning commits', async () => {
    const remote = makeRemote('idempotent');
    const machine = createMachine(root, 'idempotent');
    addSqliteSession(machine, {
      sessionId: 'ses_stable',
      projectId: 'prj',
      title: 'Stable',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'unchanged', created: 1_700_000_000_000 }],
    });
    const locations = resolveOpenCodeLocations(machine.env, 'linux');

    const first = await new SyncManager(locations, settingsFor(machine, remote)).push();
    assert.strictEqual(first.status, 'ok');

    const second = await new SyncManager(locations, settingsFor(machine, remote)).push();
    assert.strictEqual(
      second.status,
      'no-changes',
      `pushing twice with nothing changed should be a no-op, got: ${second.messages.join(' | ')}`
    );
  });

  it('recovers from a stale index.lock left by a killed git process', async () => {
    const remote = makeRemote('stale-lock');
    const machine = createMachine(root, 'stale-lock');
    addSqliteSession(machine, {
      sessionId: 'ses_locked',
      projectId: 'prj',
      title: 'Locked',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const settings = settingsFor(machine, remote);

    await new SyncManager(locations, settings).push();

    // Simulate a git process killed mid-operation: the lock is left behind,
    // aged past the staleness threshold.
    const lockPath = path.join(settings.repoDir, '.git', 'index.lock');
    fs.writeFileSync(lockPath, '', 'utf8');
    const old = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(lockPath, new Date(old), new Date(old));

    addSqliteSession(machine, {
      sessionId: 'ses_after_lock',
      projectId: 'prj',
      title: 'After lock',
      directory: '/work',
      updated: 1_700_000_100_000,
      messages: [{ id: 'm2', role: 'user', text: 'text', created: 1_700_000_100_000 }],
    });

    const outcome = await new SyncManager(locations, settingsFor(machine, remote)).push();
    assert.notStrictEqual(
      outcome.status,
      'conflict',
      `a stale lock must be cleared automatically, not block every future sync: ${outcome.messages.join(' | ')}`
    );
    assert.ok(!fs.existsSync(lockPath), 'the stale lock should have been removed');
  });

  it('refuses to sync without a remote URL instead of failing obscurely', async () => {
    const machine = createMachine(root, 'no-remote');
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    await assert.rejects(
      () => new SyncManager(locations, settingsFor(machine, '', { remoteUrl: '' })).push(),
      /syncRemoteUrl/,
      'the error must name the setting the user has to fill in'
    );
  });

  it('pulls into a completely empty machine without a pre-existing database', async () => {
    const remote = makeRemote('fresh-machine');
    const source = createMachine(root, 'fresh-source');
    addSqliteSession(source, {
      sessionId: 'ses_seed',
      projectId: 'prj',
      title: 'Seed session',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'seeded', created: 1_700_000_000_000 }],
    });
    const sourceLocations = resolveOpenCodeLocations(source.env, 'linux');
    addFavorite(sourceLocations, 'seed', 'ses_seed');
    await new SyncManager(sourceLocations, settingsFor(source, remote)).push();

    // A genuinely fresh machine: no opencode.db, no data root at all.
    const fresh = createMachine(root, 'fresh-target');
    const freshLocations = resolveOpenCodeLocations(fresh.env, 'linux');
    fs.rmSync(freshLocations.databasePath, { force: true });

    const outcome = await new SyncManager(freshLocations, settingsFor(fresh, remote)).pull();
    assert.strictEqual(outcome.status, 'ok', `pull failed: ${outcome.messages.join(' | ')}`);
    const ids = scanSessions(freshLocations).sessions.map((s) => s.id);
    assert.ok(ids.includes('ses_seed'), `a fresh machine must receive sessions. Got: ${JSON.stringify(ids)}`);
  });

  it('keeps both machines\' sessions when each created different ones', async () => {
    // The everyday two-machine case: disjoint work on both sides must union,
    // never overwrite. This is what the row-level merge exists for.
    const remote = makeRemote('union');
    const alice = createMachine(root, 'union-alice');
    const bob = createMachine(root, 'union-bob');

    addSqliteSession(alice, {
      sessionId: 'ses_alice_only',
      projectId: 'prj',
      title: 'Alice work',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'ma', role: 'user', text: 'alice text', created: 1_700_000_000_000 }],
    });
    addSqliteSession(bob, {
      sessionId: 'ses_bob_only',
      projectId: 'prj',
      title: 'Bob work',
      directory: '/work',
      updated: 1_700_000_050_000,
      messages: [{ id: 'mb', role: 'user', text: 'bob text', created: 1_700_000_050_000 }],
    });

    const aliceLocations = resolveOpenCodeLocations(alice.env, 'linux');
    const bobLocations = resolveOpenCodeLocations(bob.env, 'linux');

    await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();
    await new SyncManager(bobLocations, settingsFor(bob, remote)).pull();
    await new SyncManager(bobLocations, settingsFor(bob, remote)).push();
    await new SyncManager(aliceLocations, settingsFor(alice, remote)).pull();

    for (const [name, locations] of [
      ['alice', aliceLocations],
      ['bob', bobLocations],
    ] as const) {
      const ids = scanSessions(locations).sessions.map((s) => s.id);
      assert.ok(ids.includes('ses_alice_only'), `${name} lost alice's session: ${JSON.stringify(ids)}`);
      assert.ok(ids.includes('ses_bob_only'), `${name} lost bob's session: ${JSON.stringify(ids)}`);
    }
  });
});
