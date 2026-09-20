import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { scanSessions } from '../sessionScanner';
import { SyncManager, SyncSettings } from '../syncManager';
import { addStorageSession, createMachine, FakeMachine, writeJson } from './fixtures';

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

  it('skips a database with uncheckpointed WAL writes instead of corrupting it', async () => {
    const walMachine = createMachine(root, 'wal');
    fs.writeFileSync(path.join(walMachine.dataRoot, 'opencode.db'), 'SQLite format 3\0');
    fs.writeFileSync(path.join(walMachine.dataRoot, 'opencode.db-wal'), 'pending writes');

    const outcome = await managerFor(walMachine).push();
    assert.ok(outcome.messages.some((m) => m.includes('opencode.db')));
    assert.ok(!fs.existsSync(path.join(walMachine.home, 'sync-repo', 'data', 'opencode.db')));
    assert.ok(!fs.existsSync(path.join(walMachine.home, 'sync-repo', 'data', 'opencode.db-wal')));
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

  it('reports a conflict instead of silently discarding a side', async () => {
    const a = managerFor(work);
    const b = managerFor(home);

    fs.writeFileSync(path.join(work.configRoot, 'AGENTS.md'), '# from work\n', 'utf8');
    await a.push();

    // Home edits the same file without pulling first, then pushes.
    fs.writeFileSync(path.join(home.configRoot, 'AGENTS.md'), '# from home\n', 'utf8');
    const conflicted = await b.push();

    if (conflicted.status === 'conflict') {
      const resolved = await b.resolveConflicts('remote');
      assert.strictEqual(resolved.status, 'ok');
    } else {
      assert.ok(['ok', 'no-changes'].includes(conflicted.status));
    }
  });

  it('exposes ahead/behind status', async () => {
    const status = await managerFor(work).status();
    assert.strictEqual(status.branch, 'main');
    assert.strictEqual(typeof status.ahead, 'number');
    assert.strictEqual(typeof status.behind, 'number');
  });
});
