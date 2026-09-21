import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { scanSessions } from '../sessionScanner';
import { SyncManager, SyncSettings } from '../syncManager';
import { addFavorite } from '../favorites';
import { addSqliteSession, addStorageSession, createMachine, FakeMachine, writeJson } from './fixtures';

/**
 * End-to-end simulation: machine A pushes to a bare repo, machine B pulls,
 * and machine B's OpenCode storage must end up holding A's sessions.
 */
describe('two-machine sync simulation', () => {
  let root: string;
  let remote: string;
  let work: FakeMachine;
  let home: FakeMachine;

  const settingsFor = (machine: FakeMachine, overrides: Partial<SyncSettings> = {}): SyncSettings => ({
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

  const managerFor = (machine: FakeMachine, overrides: Partial<SyncSettings> = {}) =>
    new SyncManager(resolveOpenCodeLocations(machine.env, 'linux'), settingsFor(machine, overrides));

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-sync-'));
    remote = path.join(root, 'remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);

    work = createMachine(root, 'work');
    home = createMachine(root, 'home');

    addStorageSession(work, {
      projectId: 'prj_alpha',
      sessionId: 'ses_work1',
      title: 'Work session',
      worktree: '/work/projeto',
      messages: [{ id: 'msg_1', role: 'user', text: 'my key is sk-abcdef1234567890xyz ok?', created: 1_700_000_200_000 }],
    });

    writeJson(path.join(work.configRoot, 'opencode.json'), {
      $schema: 'https://opencode.ai/config.json',
      plugin: ['opencode-synced'],
      provider: { anthropic: { options: { apiKey: 'sk-ant-should-not-be-rewritten-000' } } },
    });
    fs.writeFileSync(path.join(work.configRoot, 'AGENTS.md'), '# Agents\n', 'utf8');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('pushes config and sessions from the work machine', async () => {
    const outcome = await managerFor(work).push();
    assert.strictEqual(outcome.status, 'ok');
    assert.ok(outcome.changedFiles > 0);
  });

  it('materializes the session in the home machine OpenCode storage after pull', async () => {
    const outcome = await managerFor(home).pull();
    assert.strictEqual(outcome.status, 'ok');

    const sessions = scanSessions(resolveOpenCodeLocations(home.env, 'linux')).sessions;
    assert.deepStrictEqual(
      sessions.map((s) => s.id),
      ['ses_work1']
    );
    assert.strictEqual(sessions[0].title, 'Work session');
    assert.ok(fs.existsSync(path.join(home.configRoot, 'AGENTS.md')));
  });

  it('redacts credentials inside synced session text', async () => {
    const messageFile = path.join(
      home.dataRoot,
      'storage',
      'part',
      'msg_1',
      'prt_msg_1.json'
    );
    const content = fs.readFileSync(messageFile, 'utf8');
    assert.ok(!content.includes('sk-abcdef1234567890xyz'), 'API key leaked into the synced session');
    assert.ok(content.includes('redacted'));
  });

  it('never rewrites config files, which would corrupt opencode.json', () => {
    const synced = JSON.parse(fs.readFileSync(path.join(home.configRoot, 'opencode.json'), 'utf8'));
    assert.strictEqual(synced.provider.anthropic.options.apiKey, 'sk-ant-should-not-be-rewritten-000');
  });

  it('reports no changes on a second pull', async () => {
    const outcome = await managerFor(home).pull();
    assert.strictEqual(outcome.status, 'no-changes');
  });

  it('does not roll back a file the local machine edited more recently', async () => {
    const localFile = path.join(home.configRoot, 'AGENTS.md');
    fs.writeFileSync(localFile, '# Agents edited locally\n', 'utf8');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(localFile, future, future);

    await managerFor(home).pull();
    assert.strictEqual(fs.readFileSync(localFile, 'utf8'), '# Agents edited locally\n');
  });

  it('fails closed: no session data syncs without a private-repo acknowledgement', async () => {
    const isolated = createMachine(root, 'unacked');
    addStorageSession(isolated, {
      projectId: 'prj_secret',
      sessionId: 'ses_secret',
      title: 'Secret session',
      worktree: '/secret',
    });

    const outcome = await managerFor(isolated, { privateRepoAcknowledged: false }).push();
    assert.ok(outcome.messages.some((m) => m.includes('NOT synced')));

    // The repo clone still carries other machines' history; what must never
    // appear is THIS machine's session, which was never authorized to leave.
    const ownSession = path.join(
      isolated.home,
      'sync-repo',
      'data',
      'storage',
      'session',
      'prj_secret',
      'ses_secret.json'
    );
    assert.ok(!fs.existsSync(ownSession), 'session data reached the repo despite failing closed');
  });

  it('skips a database a passive checkpoint cannot fully drain', async () => {
    // A small, uncommitted write transaction turns out not to reproduce this:
    // SQLite typically keeps such a tiny change in its in-memory page cache
    // and never even writes WAL frames for it until COMMIT, so there is
    // nothing on disk yet for another connection's checkpoint to be blocked
    // by. The real way a PASSIVE checkpoint stays unable to fully drain the
    // WAL is a *reader* pinned to an older snapshot: SQLite won't overwrite
    // frames a live reader still needs, so a checkpoint taken while that
    // snapshot is open is necessarily partial.
    const walMachine = createMachine(root, 'wal-pinned-reader');
    const dbPath = path.join(walMachine.dataRoot, 'opencode.db');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL;');
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
    writer.exec("INSERT INTO t (v) VALUES ('one');");

    const reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN;');
    reader.prepare('SELECT * FROM t').all(); // establishes the snapshot

    writer.exec("INSERT INTO t (v) VALUES ('two');"); // a frame the reader's snapshot excludes

    try {
      const outcome = await managerFor(walMachine).push();
      assert.ok(outcome.messages.some((m) => m.includes('opencode.db')), outcome.messages.join(' | '));
      assert.ok(!fs.existsSync(path.join(walMachine.home, 'sync-repo', 'data', 'opencode.db')));
    } finally {
      reader.exec('ROLLBACK;');
      reader.close();
      writer.close();
    }
  });

  it('a PASSIVE checkpoint syncs the database once the writer goes idle between writes', async () => {
    // This is the actual bug report this fix addresses: during a real
    // session, OpenCode isn't writing every single millisecond — it pauses
    // between messages. A sync landing in one of those gaps should capture
    // real progress instead of skipping the db on every attempt.
    const walMachine = createMachine(root, 'wal-idle-writer');
    const dbPath = path.join(walMachine.dataRoot, 'opencode.db');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL;');
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
    writer.exec("INSERT INTO t (v) VALUES ('committed');");
    // Committed and idle — no open transaction, matching the gap between
    // two messages in an active chat session.

    const outcome = await managerFor(walMachine).push();
    writer.close();

    assert.ok(!outcome.messages.some((m) => m.includes('opencode.db')), outcome.messages.join(' | '));
    assert.ok(fs.existsSync(path.join(walMachine.home, 'sync-repo', 'data', 'opencode.db')));
  });

  it('a file copy failure degrades to a skip message instead of failing the whole sync', async () => {
    // Real-world report: on Windows, fs.copyFile can throw a bare
    // "UNKNOWN: unknown error, copyfile ..." for a transient sharing
    // violation even after a successful checkpoint (SQLite or antivirus
    // briefly holding a handle). That used to propagate all the way up and
    // fail the entire push with nothing else committed. Reproduced here
    // platform-independently: a directory where a plain file is expected
    // makes fs.copyFile throw consistently on any OS.
    // A dedicated remote, so this session doesn't leak into the shared
    // `remote` and pollute later tests that assert on its exact contents.
    const isolatedRemote = path.join(root, 'locked-file-remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', isolatedRemote]);

    const lockedMachine = createMachine(root, 'locked-file');
    addStorageSession(lockedMachine, {
      projectId: 'prj_locked',
      sessionId: 'ses_locked',
      title: 'Should still sync',
      worktree: '/locked/project',
    });
    fs.mkdirSync(path.join(lockedMachine.configRoot, 'AGENTS.md')); // a directory, not a file

    const outcome = await new SyncManager(
      resolveOpenCodeLocations(lockedMachine.env, 'linux'),
      settingsFor(lockedMachine, { remoteUrl: isolatedRemote })
    ).push();

    assert.strictEqual(outcome.status, 'ok');
    assert.ok(
      outcome.messages.some((m) => m.includes('AGENTS.md') && m.includes('Skipped')),
      outcome.messages.join(' | ')
    );
    // The rest of the sync still went through despite that one failure.
    assert.ok(
      fs.existsSync(
        path.join(lockedMachine.home, 'sync-repo', 'data', 'storage', 'session', 'prj_locked', 'ses_locked.json')
      )
    );
  });

  it('merges sessions from both machines instead of deleting the other side', async () => {
    addStorageSession(home, {
      projectId: 'prj_home',
      sessionId: 'ses_home1',
      title: 'Home session',
      worktree: '/home/projeto',
    });

    await managerFor(home).push();
    await managerFor(work).pull();

    const ids = scanSessions(resolveOpenCodeLocations(work.env, 'linux')).sessions.map((s) => s.id);
    assert.deepStrictEqual(ids.sort(), ['ses_home1', 'ses_work1']);
  });

  it('reports a conflict instead of silently discarding a side, then resolving finishes the sync', async () => {
    const a = managerFor(work);
    const b = managerFor(home);

    fs.writeFileSync(path.join(work.configRoot, 'AGENTS.md'), '# from work\n', 'utf8');
    await a.push();

    // Home edits the same file without pulling first, then pushes.
    fs.writeFileSync(path.join(home.configRoot, 'AGENTS.md'), '# from home\n', 'utf8');
    const conflicted = await b.push();

    if (conflicted.status !== 'conflict') {
      assert.ok(['ok', 'no-changes'].includes(conflicted.status));
      return;
    }

    const resolved = await b.resolveConflicts('remote');
    assert.strictEqual(resolved.status, 'ok');
    assert.ok(!resolved.messages.some((m) => m.includes('could not be pushed')));

    // Resolving must not just fix the mirror: it has to land on the local
    // OpenCode file too (home asked to keep "remote", i.e. work's content)...
    assert.strictEqual(fs.readFileSync(path.join(home.configRoot, 'AGENTS.md'), 'utf8'), '# from work\n');

    // ...and the resolution commit must actually reach the remote, or the
    // next machine to sync hits the exact same conflict all over again.
    const status = await a.status();
    assert.strictEqual(status.behind, 0);
  });

  it('first-ever pull adopts the remote unconditionally, matching /sync-link', async () => {
    // Pin the remote to a known value directly, rather than relying on
    // whatever the earlier conflict test happened to leave behind.
    fs.writeFileSync(path.join(work.configRoot, 'AGENTS.md'), '# known remote content\n', 'utf8');
    await managerFor(work).push();

    const fresh = createMachine(root, 'fresh-link');
    // A pre-existing local file that predates ever linking to the sync repo —
    // /sync-link is documented to overwrite local config with synced content.
    fs.mkdirSync(fresh.configRoot, { recursive: true });
    fs.writeFileSync(path.join(fresh.configRoot, 'AGENTS.md'), '# stale local content\n', 'utf8');

    await managerFor(fresh).pull();

    assert.strictEqual(fs.readFileSync(path.join(fresh.configRoot, 'AGENTS.md'), 'utf8'), '# known remote content\n');
  });

  it('a real local edit made after a completed pull survives the next pull', async () => {
    const laptop = createMachine(root, 'laptop');
    await managerFor(laptop).pull(); // establishes this machine's "last pull" marker

    fs.writeFileSync(path.join(laptop.configRoot, 'AGENTS.md'), '# edited on laptop after pulling\n', 'utf8');

    await managerFor(laptop).pull();
    assert.strictEqual(
      fs.readFileSync(path.join(laptop.configRoot, 'AGENTS.md'), 'utf8'),
      '# edited on laptop after pulling\n'
    );
  });

  it('merges two machines pushing different sessions in sequence without ever conflicting', async () => {
    // The common case: two machines push at different times, neither aware
    // of the other's new session. Because mirrorToRepo now merges the
    // database into the mirror's existing copy instead of overwriting it,
    // this never even reaches git's binary-conflict path — both sessions
    // simply end up in the mirror.
    const dbRemote = path.join(root, 'db-sequential-remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', dbRemote]);

    const alice = createMachine(root, 'db-sequential-alice');
    const bob = createMachine(root, 'db-sequential-bob');
    const aliceManager = managerFor(alice, { remoteUrl: dbRemote });
    const bobManager = managerFor(bob, { remoteUrl: dbRemote });

    addSqliteSession(alice, {
      sessionId: 'ses_shared',
      projectId: 'prj_shared',
      title: 'Shared starting session',
      directory: '/shared/project',
      updated: 1_700_000_000_000,
    });
    await aliceManager.push();
    await bobManager.pull();

    addSqliteSession(bob, {
      sessionId: 'ses_bob_only',
      projectId: 'prj_shared',
      title: "Bob's session",
      directory: '/shared/project',
      updated: 1_700_000_600_000,
      messages: [{ id: 'msg_bob', role: 'user', text: 'question only bob asked', created: 1_700_000_600_000 }],
    });
    const bobPush = await bobManager.push();
    assert.strictEqual(bobPush.status, 'ok');

    addSqliteSession(alice, {
      sessionId: 'ses_alice_only',
      projectId: 'prj_shared',
      title: "Alice's session",
      directory: '/shared/project',
      updated: 1_700_000_500_000,
      messages: [{ id: 'msg_alice', role: 'user', text: 'question only alice asked', created: 1_700_000_500_000 }],
    });
    const alicePush = await aliceManager.push();
    assert.notStrictEqual(alicePush.status, 'conflict', alicePush.messages.join(' | '));

    await bobManager.pull();
    const bobSessions = scanSessions(resolveOpenCodeLocations(bob.env, 'linux')).sessions.map((s) => s.id);
    assert.ok(bobSessions.includes('ses_alice_only'), bobSessions.join(', '));
    assert.ok(bobSessions.includes('ses_bob_only'), bobSessions.join(', '));
  });

  it('merges opencode.db at the session level instead of discarding one machine\'s history on a real binary conflict', async () => {
    const dbRemote = path.join(root, 'db-conflict-remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', dbRemote]);

    const alice = createMachine(root, 'db-conflict-alice');
    const bob = createMachine(root, 'db-conflict-bob');
    const aliceManager = managerFor(alice, { remoteUrl: dbRemote });
    const bobManager = managerFor(bob, { remoteUrl: dbRemote });
    const bobRepoDir = path.join(bob.home, 'sync-repo');
    const bobMirrorDbPath = path.join(bobRepoDir, 'data', 'opencode.db');

    addSqliteSession(alice, {
      sessionId: 'ses_shared',
      projectId: 'prj_shared',
      title: 'Shared starting session',
      directory: '/shared/project',
      updated: 1_700_000_000_000,
    });
    await aliceManager.push(); // origin now holds commit A1 (ses_shared)
    await bobManager.pull(); // bob's mirror fast-forwards to A1

    // Simulate the real-world failure this is meant to survive: bob's own
    // sync previously got as far as committing locally, then lost network
    // before `git push` — a genuine local commit that never reached origin.
    addSqliteSession(bob, {
      sessionId: 'ses_bob_only',
      projectId: 'prj_shared',
      title: "Bob's session",
      directory: '/shared/project',
      updated: 1_700_000_600_000,
      messages: [{ id: 'msg_bob', role: 'user', text: 'question only bob asked', created: 1_700_000_600_000 }],
    });
    fs.copyFileSync(path.join(bob.dataRoot, 'opencode.db'), bobMirrorDbPath);
    spawnSync('git', ['-C', bobRepoDir, 'add', '-A']);
    spawnSync('git', ['-C', bobRepoDir, 'commit', '-m', "bob's unpushed local commit"]);

    // Meanwhile alice, unaware of bob's unpushed commit, pushes her own
    // change based on the same shared ancestor (A1) — a real divergence.
    addSqliteSession(alice, {
      sessionId: 'ses_alice_only',
      projectId: 'prj_shared',
      title: "Alice's session",
      directory: '/shared/project',
      updated: 1_700_000_500_000,
      messages: [{ id: 'msg_alice', role: 'user', text: 'question only alice asked', created: 1_700_000_500_000 }],
    });
    const alicePush = await aliceManager.push();
    assert.strictEqual(alicePush.status, 'ok');

    // Bob's next push must fetch alice's diverging commit, hit a genuine
    // binary conflict merging it against his own unpushed commit, and
    // auto-resolve it by merging sessions instead of picking a side.
    const bobPush = await bobManager.push();

    assert.notStrictEqual(bobPush.status, 'conflict', bobPush.messages.join(' | '));
    assert.ok(
      bobPush.messages.some((m) => m.includes('Merged') && m.includes('opencode.db')),
      bobPush.messages.join(' | ')
    );

    // push() only mirrors local -> repo; the merge result lands in bob's own
    // OpenCode storage on his next pull, same as any other machine's changes.
    await bobManager.pull();
    const bobSessions = scanSessions(resolveOpenCodeLocations(bob.env, 'linux')).sessions.map((s) => s.id);
    assert.ok(bobSessions.includes('ses_alice_only'), bobSessions.join(', '));
    assert.ok(bobSessions.includes('ses_bob_only'), bobSessions.join(', '));

    // And once alice pulls, she must pick up bob's session without losing her own.
    await aliceManager.pull();
    const aliceSessions = scanSessions(resolveOpenCodeLocations(alice.env, 'linux')).sessions.map((s) => s.id);
    assert.ok(aliceSessions.includes('ses_alice_only'), aliceSessions.join(', '));
    assert.ok(aliceSessions.includes('ses_bob_only'), aliceSessions.join(', '));
  });

  it('syncs a favorited session on its own even while the main database is stuck over the size limit', async () => {
    // This is the actual real-world scenario: opencode.db has genuinely
    // grown too large to sync (or the user hasn't compacted it yet), which
    // would otherwise mean NOTHING from it ever reaches the other machine.
    // Favoriting a session routes around that entirely — it's exported to
    // its own small file, independent of the giant db's fate.
    const favRemote = path.join(root, 'favorite-sync-remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', favRemote]);

    const alice = createMachine(root, 'fav-alice');
    const bob = createMachine(root, 'fav-bob');
    const aliceManager = managerFor(alice, { remoteUrl: favRemote });
    const bobManager = managerFor(bob, { remoteUrl: favRemote });

    addSqliteSession(alice, {
      sessionId: 'ses_favorited',
      projectId: 'prj_fav',
      title: 'Important session worth keeping',
      directory: '/work/important',
      updated: 1_700_000_000_000,
      messages: [{ id: 'msg_important', role: 'user', text: 'do not lose this', created: 1_700_000_000_000 }],
    });
    addFavorite(resolveOpenCodeLocations(alice.env, 'linux'), 'Important one', 'ses_favorited');

    // Bloat the main database past the sync size limit — the whole-database
    // path must never carry this session across, only the favorite export.
    fs.appendFileSync(path.join(alice.dataRoot, 'opencode.db'), Buffer.alloc(95 * 1024 * 1024, 1));

    const push = await aliceManager.push();
    assert.notStrictEqual(push.status, 'error', push.messages.join(' | '));
    assert.ok(
      push.messages.some((m) => m.includes('opencode.db') && m.includes('exceeds')),
      'expected the main database to still be reported as skipped'
    );
    assert.ok(
      !fs.existsSync(path.join(alice.home, 'sync-repo', 'data', 'opencode.db')),
      'the oversized main database must not reach the mirror'
    );
    assert.ok(
      fs.existsSync(path.join(alice.home, 'sync-repo', 'data', 'favorite-sessions', 'ses_favorited.db')),
      'the favorited session must reach the mirror on its own'
    );

    await bobManager.pull();
    const bobSessions = scanSessions(resolveOpenCodeLocations(bob.env, 'linux')).sessions.map((s) => s.id);
    assert.ok(bobSessions.includes('ses_favorited'), bobSessions.join(', '));
  });

  it('does not let one broken favorite block another from syncing', async () => {
    const remote = path.join(root, 'mixed-favorites-remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);

    const alice = createMachine(root, 'mixed-fav-alice');
    const bob = createMachine(root, 'mixed-fav-bob');
    const aliceManager = managerFor(alice, { remoteUrl: remote });

    addSqliteSession(alice, {
      sessionId: 'ses_real',
      projectId: 'prj_mixed',
      title: 'A real session',
      directory: '/work/real',
      updated: 1_700_000_000_000,
    });
    const locations = resolveOpenCodeLocations(alice.env, 'linux');
    addFavorite(locations, 'Real one', 'ses_real');
    addFavorite(locations, 'Points nowhere', 'ses_does_not_exist_at_all');

    const push = await aliceManager.push();
    assert.notStrictEqual(push.status, 'error', push.messages.join(' | '));
    assert.ok(
      push.messages.some((m) => m.includes('ses_does_not_exist_at_all') && m.includes('not synced')),
      push.messages.join(' | ')
    );
    assert.ok(
      fs.existsSync(path.join(alice.home, 'sync-repo', 'data', 'favorite-sessions', 'ses_real.db')),
      'the valid favorite must still sync despite the broken one'
    );

    await managerFor(bob, { remoteUrl: remote }).pull();
    const bobSessions = scanSessions(resolveOpenCodeLocations(bob.env, 'linux')).sessions.map((s) => s.id);
    assert.ok(bobSessions.includes('ses_real'));
  });

  it('exposes ahead/behind status', async () => {
    const status = await managerFor(work).status();
    assert.strictEqual(status.branch, 'main');
    assert.strictEqual(typeof status.ahead, 'number');
    assert.strictEqual(typeof status.behind, 'number');
  });

  it('skips a database over the sync size limit instead of trying to push a file GitHub would reject', async () => {
    // GitHub hard-rejects any single file over 100 MB; syncing one that big
    // would also mean git spends real time hashing/compressing it locally
    // first. Reproduces the real-world report: opencode.db grows unbounded
    // and every sync either hangs or fails outright once it crosses that line.
    const oversizedRemote = path.join(root, 'oversized-remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', oversizedRemote]);

    const bigMachine = createMachine(root, 'oversized-db');
    const dbPath = path.join(bigMachine.dataRoot, 'opencode.db');
    fs.writeFileSync(dbPath, Buffer.alloc(95 * 1024 * 1024, 1));

    const outcome = await new SyncManager(
      resolveOpenCodeLocations(bigMachine.env, 'linux'),
      settingsFor(bigMachine, { remoteUrl: oversizedRemote })
    ).push();

    // Nothing else was configured to sync for this machine, so once the
    // oversized db is skipped there's genuinely nothing left to commit —
    // what matters is that it was skipped with a clear reason, not silently.
    assert.notStrictEqual(outcome.status, 'error', outcome.messages.join(' | '));
    assert.ok(
      outcome.messages.some((m) => m.includes('opencode.db') && m.includes('exceeds') && m.includes('90 MB')),
      outcome.messages.join(' | ')
    );
    assert.ok(
      !fs.existsSync(path.join(bigMachine.home, 'sync-repo', 'data', 'opencode.db')),
      'the oversized file must never reach the sync repo'
    );
  });

  it('reports an oversized database in the debug report even before any sync has run', async () => {
    const debugMachine = createMachine(root, 'oversized-debug');
    fs.writeFileSync(path.join(debugMachine.dataRoot, 'opencode.db'), Buffer.alloc(95 * 1024 * 1024, 1));

    const manager = new SyncManager(
      resolveOpenCodeLocations(debugMachine.env, 'linux'),
      settingsFor(debugMachine, { remoteUrl: path.join(root, 'unused-remote.git') })
    );
    const report = await manager.debugReport();
    assert.ok(report.includes('Oversized files') && report.includes('opencode.db'), report);
  });

  it('recovers from a stale index.lock left behind by a killed git process', async () => {
    const staleRemote = path.join(root, 'stale-lock-remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', staleRemote]);

    const machine = createMachine(root, 'stale-lock');
    addStorageSession(machine, {
      projectId: 'prj_stale',
      sessionId: 'ses_stale',
      title: 'Should still sync once unstuck',
      worktree: '/stale/project',
    });
    const manager = new SyncManager(
      resolveOpenCodeLocations(machine.env, 'linux'),
      settingsFor(machine, { remoteUrl: staleRemote })
    );

    // Establish the repo, then simulate a crashed git process: a leftover
    // index.lock with an old mtime, which real git never clears on its own.
    await manager.ensureRepo();
    const lockPath = path.join(machine.home, 'sync-repo', '.git', 'index.lock');
    fs.writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);

    const outcome = await manager.push();
    assert.strictEqual(outcome.status, 'ok', outcome.messages.join(' | '));
    assert.ok(!fs.existsSync(lockPath), 'stale lock should have been cleared');
  });

  it('leaves a fresh index.lock alone instead of racing a real concurrent git process', async () => {
    const freshRemote = path.join(root, 'fresh-lock-remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', freshRemote]);

    const machine = createMachine(root, 'fresh-lock');
    const manager = new SyncManager(
      resolveOpenCodeLocations(machine.env, 'linux'),
      settingsFor(machine, { remoteUrl: freshRemote })
    );

    await manager.ensureRepo();
    const lockPath = path.join(machine.home, 'sync-repo', '.git', 'index.lock');
    fs.writeFileSync(lockPath, ''); // freshly created — mtime is "now"

    await assert.rejects(() => manager.push());
    assert.ok(fs.existsSync(lockPath), 'a fresh lock must not be deleted out from under a real operation');

    fs.rmSync(lockPath, { force: true }); // clean up so it doesn't affect later tests
  });
});
