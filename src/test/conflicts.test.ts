import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { SyncManager, SyncSettings } from '../syncManager';
import { scanSessions } from '../sessionScanner';
import { addSqliteSession, createMachine, FakeMachine, writeJson } from './fixtures';

/**
 * Conflict handling, driven through real git repositories. A conflict is the
 * point where this tool can most easily lose a machine's work, so these
 * assert on what survives rather than on status codes.
 */
describe('conflict handling between two machines', () => {
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-conflict-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('merges both machines\' sessions instead of forcing a pick-a-side on the database', async () => {
    // Both machines write to opencode.db independently and push. git sees a
    // binary conflict on a single file; resolving it by picking a side would
    // silently discard one machine's entire session history. The row-level
    // merge is what makes this survivable.
    const remote = makeRemote('db-conflict');
    const alice = createMachine(root, 'conflict-alice');
    const bob = createMachine(root, 'conflict-bob');

    addSqliteSession(alice, {
      sessionId: 'ses_alice_conflict',
      projectId: 'prj',
      title: 'Alice conflict work',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'ma', role: 'user', text: 'alice content', created: 1_700_000_000_000 }],
    });
    addSqliteSession(bob, {
      sessionId: 'ses_bob_conflict',
      projectId: 'prj',
      title: 'Bob conflict work',
      directory: '/work',
      updated: 1_700_000_010_000,
      messages: [{ id: 'mb', role: 'user', text: 'bob content', created: 1_700_000_010_000 }],
    });

    const aliceLocations = resolveOpenCodeLocations(alice.env, 'linux');
    const bobLocations = resolveOpenCodeLocations(bob.env, 'linux');

    // Alice publishes first.
    await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();

    // Bob has never pulled, so his push collides with alice's database.
    const bobPush = await new SyncManager(bobLocations, settingsFor(bob, remote)).push();
    assert.notStrictEqual(bobPush.status, 'conflict', `bob's push should auto-merge, not stall: ${bobPush.messages.join(' | ')}`);

    // push() mirrors local -> repo and deliberately does not write back to
    // local storage, so bob only gains alice's session once he pulls. What
    // must hold right now is that his push did not CLOBBER her rows in the
    // repo — that is the data-loss failure this merge exists to prevent.
    await new SyncManager(bobLocations, settingsFor(bob, remote)).pull();
    const bobIds = scanSessions(bobLocations).sessions.map((s) => s.id);
    assert.ok(bobIds.includes('ses_bob_conflict'), 'bob must keep his own session');
    assert.ok(bobIds.includes('ses_alice_conflict'), `bob must gain alice's session: ${JSON.stringify(bobIds)}`);

    await new SyncManager(aliceLocations, settingsFor(alice, remote)).pull();
    const aliceIds = scanSessions(aliceLocations).sessions.map((s) => s.id);
    assert.ok(aliceIds.includes('ses_alice_conflict'), 'alice must keep her own session');
    assert.ok(aliceIds.includes('ses_bob_conflict'), `alice must gain bob's session: ${JSON.stringify(aliceIds)}`);
  });

  it('resolving a text conflict by keeping local publishes that resolution', async () => {
    // A conflict on a text config file can't be row-merged, so it surfaces
    // for the user to resolve. Resolving must also PUSH the resolution —
    // leaving it committed locally but unpushed means the next machine hits
    // the identical conflict all over again.
    const remote = makeRemote('text-conflict');
    const alice = createMachine(root, 'text-alice');
    const bob = createMachine(root, 'text-bob');

    const aliceLocations = resolveOpenCodeLocations(alice.env, 'linux');
    const bobLocations = resolveOpenCodeLocations(bob.env, 'linux');

    writeJson(path.join(alice.configRoot, 'opencode.json'), { theme: 'alice-theme' });
    await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();

    await new SyncManager(bobLocations, settingsFor(bob, remote)).pull();

    // Both edit the same file differently, without syncing in between.
    writeJson(path.join(alice.configRoot, 'opencode.json'), { theme: 'alice-updated' });
    writeJson(path.join(bob.configRoot, 'opencode.json'), { theme: 'bob-updated' });

    await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();
    const bobPush = await new SyncManager(bobLocations, settingsFor(bob, remote)).push();

    if (bobPush.status === 'conflict') {
      const resolved = await new SyncManager(bobLocations, settingsFor(bob, remote)).resolveConflicts('local');
      assert.notStrictEqual(resolved.status, 'conflict', 'resolving must clear the conflict');

      // The resolution must be on the remote, not stranded locally.
      const remoteHead = spawnSync('git', ['show', 'main:config/opencode.json'], {
        cwd: remote,
        encoding: 'utf8',
      }).stdout;
      assert.ok(
        remoteHead.includes('bob-updated'),
        `bob's kept-local resolution must reach the remote, got: ${remoteHead}`
      );
    }
  });

  it('a conflicted state does not lose the local session database', async () => {
    // Whatever happens to text files, a conflict must never cost the user
    // their local session history.
    const remote = makeRemote('conflict-preserves');
    const alice = createMachine(root, 'preserve-alice');
    const bob = createMachine(root, 'preserve-bob');

    const aliceLocations = resolveOpenCodeLocations(alice.env, 'linux');
    const bobLocations = resolveOpenCodeLocations(bob.env, 'linux');

    writeJson(path.join(alice.configRoot, 'opencode.json'), { theme: 'base' });
    await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();
    await new SyncManager(bobLocations, settingsFor(bob, remote)).pull();

    addSqliteSession(bob, {
      sessionId: 'ses_bob_precious',
      projectId: 'prj',
      title: 'Precious local work',
      directory: '/work',
      updated: 1_700_000_500_000,
      messages: [{ id: 'mp', role: 'user', text: 'must survive', created: 1_700_000_500_000 }],
    });

    writeJson(path.join(alice.configRoot, 'opencode.json'), { theme: 'alice-side' });
    writeJson(path.join(bob.configRoot, 'opencode.json'), { theme: 'bob-side' });
    await new SyncManager(aliceLocations, settingsFor(alice, remote)).push();
    await new SyncManager(bobLocations, settingsFor(bob, remote)).push();

    const ids = scanSessions(bobLocations).sessions.map((s) => s.id);
    assert.ok(
      ids.includes('ses_bob_precious'),
      `a conflict must never drop local session history: ${JSON.stringify(ids)}`
    );
  });
});
