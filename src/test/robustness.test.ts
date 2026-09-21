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

describe('unreachable remote', () => {
  let root: string;

  const settingsFor = (machine: FakeMachine, remote: string): SyncSettings => ({
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
  });

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-unreachable-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('fails loudly when the remote cannot be reached, instead of reporting a clean sync', async () => {
    // A real report reached 16 unpushed commits this way: every fetch
    // failure was treated as "the remote is just empty", so a sync that
    // never contacted GitHub reported success, committed locally, and only
    // failed at the final push — where the error was easy to miss. The
    // failure has to surface at the point nothing could be fetched.
    const machine = createMachine(root, 'unreachable');
    addSqliteSession(machine, {
      sessionId: 'ses_stranded',
      projectId: 'prj',
      title: 'Stranded',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    // A path that is not a git repository at all: git fails to fetch from it
    // the same way it does for a bad URL or rejected credentials.
    const missing = path.join(root, 'does-not-exist.git');

    await assert.rejects(
      () => new SyncManager(locations, settingsFor(machine, missing)).push(),
      (err: Error) => /Could not reach the sync repository/.test(err.message),
      "the failure must be reported as not reaching the repository, at the point the fetch failed — " +
        "not left to surface later as git's own push error"
    );

    // The symptom that actually reached the user: because the failure was
    // swallowed, each attempt still committed locally and only the final
    // push failed, so commits piled up (a real report hit 16 ahead) while
    // the panel reported success. Nothing may be committed when the remote
    // could not be reached at all.
    const countCommits = () => {
      const result = spawnSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: path.join(machine.home, 'sync-repo'),
        encoding: 'utf8',
      });
      return result.status === 0 ? Number(result.stdout.trim()) : 0;
    };
    const afterFirst = countCommits();

    await assert.rejects(() => new SyncManager(locations, settingsFor(machine, missing)).push());
    assert.strictEqual(
      countCommits(),
      afterFirst,
      'repeated failing syncs must not accumulate local commits that can never be pushed'
    );
  });

  it('still treats a reachable but branch-less remote as a normal first push', async () => {
    // The one benign fetch failure: a repository created empty. This must
    // keep working, or a first-time setup would look like a hard failure.
    const machine = createMachine(root, 'empty-remote');
    addSqliteSession(machine, {
      sessionId: 'ses_first',
      projectId: 'prj',
      title: 'First ever push',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });

    const remote = path.join(root, 'empty.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const outcome = await new SyncManager(locations, settingsFor(machine, remote)).push();
    assert.strictEqual(outcome.status, 'ok', `first push to an empty remote must work: ${outcome.messages.join(' | ')}`);
  });

  it('reports unpushed commits and an unreachable remote in the debug report', async () => {
    const machine = createMachine(root, 'debug-unpushed');
    addSqliteSession(machine, {
      sessionId: 'ses_dbg',
      projectId: 'prj',
      title: 'Debug',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });
    const remote = path.join(root, 'debug.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    await new SyncManager(locations, settingsFor(machine, remote)).push();

    // Point at a remote that no longer exists, the way a revoked credential
    // or a deleted repository would behave.
    fs.rmSync(remote, { recursive: true, force: true });
    const report = await new SyncManager(locations, settingsFor(machine, remote)).debugReport();

    assert.ok(
      /Remote reachable: NO/.test(report),
      `the report must say the remote is unreachable. Got:\n${report}`
    );
  });
});

describe('recovering a mirror whose history GitHub will never accept', () => {
  let root: string;

  const settingsFor = (machine: FakeMachine, remote: string): SyncSettings => ({
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
  });

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-rebuild-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('never leaves export scratch files inside the repo, even on a crash', async () => {
    // A real report: five `<id>.db.tmp-<pid>-<ts>` files had been committed
    // into the sync repo by interrupted exports, one of them over GitHub's
    // 100 MB limit, which blocked every push from then on. Scratch files
    // must not be written into the repo at all.
    const machine = createMachine(root, 'no-strays');
    addSqliteSession(machine, {
      sessionId: 'ses_scratch',
      projectId: 'prj',
      title: 'Scratch',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });
    const remote = path.join(root, 'no-strays.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const settings = settingsFor(machine, remote);

    await new SyncManager(locations, settings).push();

    const exportDir = path.join(settings.repoDir, 'data', 'favorite-sessions');
    const strays = fs.existsSync(exportDir)
      ? fs.readdirSync(exportDir).filter((f) => /\.tmp-\d+-\d+$/.test(f))
      : [];
    assert.deepStrictEqual(strays, [], 'no scratch files may be left inside the repo');

    const committed = spawnSync('git', ['ls-tree', '-r', '--name-only', 'main'], {
      cwd: remote,
      encoding: 'utf8',
    }).stdout;
    assert.ok(!/\.tmp-\d+-\d+/.test(committed), `no scratch file may be committed. Got:\n${committed}`);
  });

  it('cleans up and refuses to commit scratch files an older build left behind', async () => {
    // An existing mirror still has them on disk; every `git add -A` would
    // commit them again until something removes them.
    const machine = createMachine(root, 'clean-strays');
    addSqliteSession(machine, {
      sessionId: 'ses_clean',
      projectId: 'prj',
      title: 'Clean',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });
    const remote = path.join(root, 'clean-strays.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const settings = settingsFor(machine, remote);

    await new SyncManager(locations, settings).push();

    // Plant leftovers exactly as the older build named them.
    const exportDir = path.join(settings.repoDir, 'data', 'favorite-sessions');
    fs.mkdirSync(exportDir, { recursive: true });
    const stray = path.join(exportDir, 'ses_clean.db.tmp-14156-1789966456755');
    fs.writeFileSync(stray, 'leftover garbage', 'utf8');

    addSqliteSession(machine, {
      sessionId: 'ses_clean2',
      projectId: 'prj',
      title: 'Clean 2',
      directory: '/work',
      updated: 1_700_000_100_000,
      messages: [{ id: 'm2', role: 'user', text: 'more', created: 1_700_000_100_000 }],
    });
    await new SyncManager(locations, settingsFor(machine, remote)).push();

    assert.ok(!fs.existsSync(stray), 'the leftover scratch file should have been removed');
    const committed = spawnSync('git', ['ls-tree', '-r', '--name-only', 'main'], {
      cwd: remote,
      encoding: 'utf8',
    }).stdout;
    assert.ok(!/\.tmp-\d+-\d+/.test(committed), `a leftover scratch file was committed:\n${committed}`);
  });

  it('rebuilds the mirror from the remote, discarding unpushable local history', async () => {
    // The recovery path for the reported dead end: unpushed commits carrying
    // a blob GitHub rejects, with no way forward short of git surgery.
    const machine = createMachine(root, 'rebuild');
    addSqliteSession(machine, {
      sessionId: 'ses_rebuild',
      projectId: 'prj',
      title: 'Rebuild me',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });
    const remote = path.join(root, 'rebuild.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const settings = settingsFor(machine, remote);

    await new SyncManager(locations, settings).push();

    // Poison the mirror the way the real one was: a commit that exists only
    // locally and can never be pushed.
    const poison = path.join(settings.repoDir, 'data', 'favorite-sessions', 'huge.db.tmp-999-1');
    fs.mkdirSync(path.dirname(poison), { recursive: true });
    fs.writeFileSync(poison, 'x'.repeat(1024), 'utf8');
    spawnSync('git', ['add', '-A', '-f'], { cwd: settings.repoDir });
    spawnSync('git', ['commit', '-m', 'poisoned commit'], { cwd: settings.repoDir });

    const aheadBefore = Number(
      spawnSync('git', ['rev-list', '--count', 'origin/main..HEAD'], {
        cwd: settings.repoDir,
        encoding: 'utf8',
      }).stdout.trim()
    );
    assert.strictEqual(aheadBefore, 1, 'the mirror should be carrying one unpushable commit');

    const result = await new SyncManager(locations, settingsFor(machine, remote)).rebuildMirror();
    assert.strictEqual(result.discardedCommits, 1);

    const aheadAfter = Number(
      spawnSync('git', ['rev-list', '--count', 'origin/main..HEAD'], {
        cwd: settings.repoDir,
        encoding: 'utf8',
      }).stdout.trim()
    );
    assert.strictEqual(aheadAfter, 0, 'the rebuilt mirror must match the remote');
    assert.ok(!fs.existsSync(poison), 'the poisoned file must be gone');

    // And the mirror is usable again: a push succeeds afterwards.
    addSqliteSession(machine, {
      sessionId: 'ses_after_rebuild',
      projectId: 'prj',
      title: 'After rebuild',
      directory: '/work',
      updated: 1_700_000_200_000,
      messages: [{ id: 'm2', role: 'user', text: 'text', created: 1_700_000_200_000 }],
    });
    const outcome = await new SyncManager(locations, settingsFor(machine, remote)).push();
    assert.strictEqual(outcome.status, 'ok', `push after rebuild failed: ${outcome.messages.join(' | ')}`);
  });

  it('keeps sessions that were already on the remote after a rebuild', async () => {
    // Rebuilding must not cost the user anything already pushed.
    const machine = createMachine(root, 'rebuild-keeps');
    addSqliteSession(machine, {
      sessionId: 'ses_safe',
      projectId: 'prj',
      title: 'Already pushed',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'safe content', created: 1_700_000_000_000 }],
    });
    const remote = path.join(root, 'rebuild-keeps.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    await new SyncManager(locations, settingsFor(machine, remote)).push();

    await new SyncManager(locations, settingsFor(machine, remote)).rebuildMirror();

    // This database is under the size limit, so the session travelled in the
    // whole-database mirror rather than as its own export file — either way,
    // what was pushed before the rebuild has to still be there afterwards.
    const files = spawnSync('git', ['ls-tree', '-r', '--name-only', 'main'], {
      cwd: path.join(machine.home, 'sync-repo'),
      encoding: 'utf8',
    }).stdout;
    assert.ok(
      files.includes('data/opencode.db'),
      `the rebuilt mirror must still carry what was already on the remote. Got:\n${files}`
    );

    // And the content is really there, not just the path: a fresh machine
    // pulling from the remote still receives the session.
    const fresh = createMachine(root, 'rebuild-keeps-reader');
    const freshLocations = resolveOpenCodeLocations(fresh.env, 'linux');
    fs.rmSync(freshLocations.databasePath, { force: true });
    await new SyncManager(freshLocations, settingsFor(fresh, remote)).pull();
    assert.ok(
      scanSessions(freshLocations).sessions.some((s) => s.id === 'ses_safe'),
      'the already-pushed session must still be retrievable after a rebuild'
    );
  });
});

describe('a single session too large to sync', () => {
  it('skips only that session, syncs the rest, and says which one it was', async () => {
    // A real machine had one session whose own export exceeded GitHub's
    // limit. Compacting opencode.db does nothing for that, so the message
    // must name the session rather than repeat the database advice.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-huge-session-'));
    try {
      const machine = createMachine(root, 'huge-session');
      const remote = path.join(root, 'huge.git');
      spawnSync('git', ['init', '--bare', '-b', 'main', remote]);

      addSqliteSession(machine, {
        sessionId: 'ses_normal',
        projectId: 'prj',
        title: 'Normal session',
        directory: '/work',
        updated: 1_700_000_000_000,
        messages: [{ id: 'm1', role: 'user', text: 'small', created: 1_700_000_000_000 }],
      });
      // One session with enough content that its own export passes the limit.
      addSqliteSession(machine, {
        sessionId: 'ses_enormous',
        projectId: 'prj',
        title: 'Enormous session',
        directory: '/work',
        updated: 1_700_000_100_000,
        messages: [{ id: 'm2', role: 'user', text: 'big', created: 1_700_000_100_000 }],
      });

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(machine.dataRoot, 'opencode.db'));
      const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
      const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
      const chunk = 'z'.repeat(200_000);
      db.exec('BEGIN;');
      for (let i = 0; i < 500; i++) {
        insertMessage.run(`huge_m${i}`, 'ses_enormous', 1, 1, '{}');
        insertPart.run(`huge_p${i}`, `huge_m${i}`, 'ses_enormous', 1, 1, JSON.stringify({ type: 'text', text: chunk }));
      }
      db.exec('COMMIT;');
      db.close();

      const locations = resolveOpenCodeLocations(machine.env, 'linux');
      // Force the per-session route by pushing opencode.db over the limit.
      const fd = fs.openSync(locations.databasePath, 'r+');
      const currentSize = fs.fstatSync(fd).size;
      fs.ftruncateSync(fd, Math.max(currentSize, 95 * 1024 * 1024));
      fs.closeSync(fd);

      const outcome = await new SyncManager(locations, {
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
      }).push();

      const committed = spawnSync('git', ['ls-tree', '-r', '--name-only', 'main'], {
        cwd: remote,
        encoding: 'utf8',
      }).stdout;
      assert.ok(
        committed.includes('data/favorite-sessions/ses_normal.db'),
        `the normal session must still sync. Got:\n${committed}`
      );
      assert.ok(
        !committed.includes('data/favorite-sessions/ses_enormous.db'),
        'the oversized session must not be committed'
      );

      const combined = outcome.messages.join(' | ');
      assert.ok(
        /Enormous session/.test(combined) && /too large to sync on its own/.test(combined),
        `the message must name the session and its real problem. Got: ${combined}`
      );
      assert.ok(
        !/Compact Database/.test(combined.split('Enormous session')[1] ?? ''),
        'compacting the database is not the fix for one oversized session'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
