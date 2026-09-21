import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { SyncManager, SyncSettings } from '../syncManager';
import { addSqliteSession, createMachine, FakeMachine, writeJson } from './fixtures';

/**
 * What actually lands in the sync repository, checked against the committed
 * bytes rather than against intermediate state. A regression here publishes
 * the user's credentials, so these assert on the remote's real contents.
 */
describe('what reaches the remote repository', () => {
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

  const remoteFileContents = (remote: string, repoPath: string): string =>
    spawnSync('git', ['show', `main:${repoPath}`], { cwd: remote, encoding: 'utf8' }).stdout;

  const remoteFiles = (remote: string): string[] =>
    spawnSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: remote, encoding: 'utf8' })
      .stdout.split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-secrets-'));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('replaces MCP server credentials with env placeholders in the committed config', async () => {
    const remote = makeRemote('mcp-secrets');
    const machine = createMachine(root, 'mcp-secrets');
    writeJson(path.join(machine.configRoot, 'opencode.json'), {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        github: {
          type: 'local',
          command: ['npx', 'server-github'],
          environment: { GITHUB_TOKEN: 'ghp_realsecrettokenvalue123456' },
        },
      },
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    const outcome = await new SyncManager(locations, settingsFor(machine, remote)).push();
    assert.strictEqual(outcome.status, 'ok', outcome.messages.join(' | '));

    const committed = remoteFileContents(remote, 'config/opencode.json');
    assert.ok(
      !committed.includes('ghp_realsecrettokenvalue123456'),
      `the real MCP token must never be committed. Committed: ${committed}`
    );
    assert.ok(committed.includes('{env:'), `expected an {env:...} placeholder instead, got: ${committed}`);
  });

  it('never commits any session data while the secrets gate is closed', async () => {
    const remote = makeRemote('gate-closed');
    const machine = createMachine(root, 'gate-closed');
    addSqliteSession(machine, {
      sessionId: 'ses_private',
      projectId: 'prj',
      title: 'Private conversation',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'confidential business plan', created: 1_700_000_000_000 }],
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    await new SyncManager(
      locations,
      settingsFor(machine, remote, { includeSecrets: false, privateRepoAcknowledged: false })
    ).push();

    const files = remoteFiles(remote);
    assert.ok(!files.includes('data/opencode.db'), `the database must not be committed: ${JSON.stringify(files)}`);
    assert.ok(
      !files.some((f) => f.startsWith('data/favorite-sessions/')),
      `no per-session export may be committed either: ${JSON.stringify(files)}`
    );
  });

  it('never commits volatile SQLite sidecar files', async () => {
    // A -wal/-shm file can be mid-write; committing one produces a database
    // the other machine cannot open.
    const remote = makeRemote('no-sidecars');
    const machine = createMachine(root, 'no-sidecars');
    addSqliteSession(machine, {
      sessionId: 'ses_sidecar',
      projectId: 'prj',
      title: 'Sidecar test',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });
    fs.writeFileSync(path.join(machine.dataRoot, 'opencode.db-wal'), 'pending frames', 'utf8');
    fs.writeFileSync(path.join(machine.dataRoot, 'opencode.db-shm'), 'shared memory', 'utf8');

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    await new SyncManager(locations, settingsFor(machine, remote)).push();

    const files = remoteFiles(remote);
    assert.ok(
      !files.some((f) => f.endsWith('-wal') || f.endsWith('-shm')),
      `volatile sidecars must never be committed: ${JSON.stringify(files)}`
    );
  });

  it('commits the favorites and tombstone files so both travel between machines', async () => {
    const remote = makeRemote('metadata-files');
    const machine = createMachine(root, 'metadata-files');
    addSqliteSession(machine, {
      sessionId: 'ses_meta',
      projectId: 'prj',
      title: 'Meta',
      directory: '/work',
      updated: 1_700_000_000_000,
      messages: [{ id: 'm1', role: 'user', text: 'text', created: 1_700_000_000_000 }],
    });

    const locations = resolveOpenCodeLocations(machine.env, 'linux');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../favorites').addFavorite(locations, 'kept', 'ses_meta');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../deletedSessions').markSessionDeleted(locations, 'ses_gone_elsewhere');

    await new SyncManager(locations, settingsFor(machine, remote)).push();

    const files = remoteFiles(remote);
    assert.ok(
      files.includes('config/opencode-session-hub-favorites.json'),
      `favorites must sync: ${JSON.stringify(files)}`
    );
    assert.ok(
      files.includes('config/opencode-session-hub-deleted-sessions.json'),
      `tombstones must sync, or deletions cannot propagate: ${JSON.stringify(files)}`
    );
  });
});
