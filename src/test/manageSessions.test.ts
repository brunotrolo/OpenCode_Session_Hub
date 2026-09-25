import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { addEventSession, addStorageSession, createMachine, FakeMachine } from './fixtures';
import { installVscodeStub, StubState, StubWebviewPanel } from './vscodeStub';

/**
 * Drives the bulk-delete session manager's webview protocol directly —
 * the same messages its page posts — against a real SyncController:
 * list everything, delete a chosen subset, leave the rest alone.
 */
describe('session manager (bulk delete)', () => {
  let root: string;
  let remote: string;
  let machine: FakeMachine;
  let stub: StubState;
  let SyncController: typeof import('../syncController').SyncController;
  let showSessionManager: typeof import('../sessionManagerPanel').showSessionManager;
  let controller: InstanceType<typeof SyncController>;
  let panel: StubWebviewPanel;
  let demoDir: string;

  const sessionIds = ['ses_bulk1', 'ses_bulk2', 'ses_bulk3', 'ses_bulk4'];

  function context() {
    return { globalStorageUri: { fsPath: path.join(machine.home, 'globalStorage') } };
  }

  function latestState(): any {
    const states = panel.posted.filter((m: any) => m.type === 'state');
    return states[states.length - 1];
  }

  let previousConfigDirEnv: string | undefined;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-manage-'));
    remote = path.join(root, 'remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    machine = createMachine(root, 'work');
    demoDir = path.join(root, 'demo-project');
    fs.mkdirSync(demoDir, { recursive: true });

    sessionIds.forEach((sessionId, i) => {
      addStorageSession(machine, {
        projectId: 'prj_a',
        sessionId,
        title: `Bulk session ${i + 1}`,
        worktree: demoDir,
      });
    });

    stub = installVscodeStub();
    stub.config['dataPath'] = machine.dataRoot;
    previousConfigDirEnv = process.env.opencode_config_dir;
    process.env.opencode_config_dir = machine.configRoot;

    SyncController = require('../syncController').SyncController;
    showSessionManager = require('../sessionManagerPanel').showSessionManager;
  });

  after(() => {
    if (previousConfigDirEnv === undefined) {
      delete process.env.opencode_config_dir;
    } else {
      process.env.opencode_config_dir = previousConfigDirEnv;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    const output = { appendLine: () => undefined, dispose: () => undefined };
    controller = new SyncController(context() as never, output as never);
    stub.webviews.length = 0;
    stub.messages.length = 0;
    showSessionManager(controller);
    assert.strictEqual(stub.webviews.length, 1);
    panel = stub.webviews[0];
  });

  it('lists every session on ready', async () => {
    await panel.onMessage!({ type: 'ready' });
    const state = latestState();
    assert.strictEqual(state.sessions.length, 4);
    assert.deepStrictEqual(
      state.sessions.map((s: { id: string }) => s.id).sort(),
      [...sessionIds].sort()
    );
  });

  it('marks sessions that reached the sync mirror as synced', async () => {
    const exportDir = path.join(machine.home, 'globalStorage', 'sync-repo', 'data', 'favorite-sessions');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'ses_bulk1.db'), 'fake-export');

    await panel.onMessage!({ type: 'ready' });
    const state = latestState();
    const byId = new Map<string, any>(state.sessions.map((s: { id: string }) => [s.id, s]));
    assert.strictEqual(byId.get('ses_bulk1').synced, true);
    assert.strictEqual(byId.get('ses_bulk2').synced, false);
  });

  it('deletes exactly the selected sessions and keeps the rest', async () => {
    stub.warningResponder = () => 'Delete';
    await panel.onMessage!({ type: 'ready' });
    await panel.onMessage!({ type: 'deleteSelected', ids: ['ses_bulk1', 'ses_bulk3', 'does-not-exist'] });

    const state = latestState();
    assert.deepStrictEqual(
      state.sessions.map((s: { id: string }) => s.id).sort(),
      ['ses_bulk2', 'ses_bulk4']
    );
    assert.ok(
      stub.messages.some((m) => m.kind === 'info' && m.text.includes('Deleted 2 session(s)')),
      `expected a bulk-delete confirmation, got: ${JSON.stringify(stub.messages)}`
    );
  });

  it('cancelling the confirmation deletes nothing', async () => {
    stub.warningResponder = () => undefined;
    stub.messages.length = 0;
    await panel.onMessage!({ type: 'ready' });
    const before = latestState().sessions.length;
    await panel.onMessage!({ type: 'deleteSelected', ids: ['ses_bulk1', 'ses_bulk2'] });

    assert.strictEqual(latestState().sessions.length, before);
    assert.ok(!stub.messages.some((m) => m.text.includes('Deleted')));
  });

  it('previews a session inline without leaving the manager', async () => {
    await panel.onMessage!({ type: 'ready' });
    const before = stub.webviews.length;
    await panel.onMessage!({ type: 'previewSession', id: 'ses_bulk2' });

    assert.strictEqual(stub.webviews.length, before + 1);
    assert.ok(stub.webviews[before].html.includes('Bulk session 2'));
  });

  it('resumes a session in a terminal for its recorded directory', async () => {
    stub.terminals.length = 0;
    await panel.onMessage!({ type: 'ready' });
    await panel.onMessage!({ type: 'resumeSession', id: 'ses_bulk2' });

    assert.strictEqual(stub.terminals.length, 1);
    assert.strictEqual(stub.terminals[0].cwd, demoDir);
    assert.deepStrictEqual(stub.terminals[0].sent, ['opencode --session ses_bulk2']);
  });

  it('exports the selected sessions as Markdown into the chosen folder', async () => {
    const exportDir = path.join(root, 'md-export');
    fs.mkdirSync(exportDir, { recursive: true });
    stub.openDialogPaths = [{ fsPath: exportDir }];
    stub.messages.length = 0;
    await panel.onMessage!({ type: 'ready' });
    await panel.onMessage!({ type: 'exportSelected', ids: ['ses_bulk2', 'ses_bulk4'] });

    const files = fs.readdirSync(exportDir).sort();
    assert.strictEqual(files.length, 2);
    const body = fs.readFileSync(path.join(exportDir, files[0]), 'utf8');
    assert.ok(body.includes('# Bulk session'));
    assert.ok(body.includes('Session ID: ses_bulk'));
    assert.ok(
      stub.messages.some((m) => m.kind === 'info' && m.text.includes('Exported 2 of 2')),
      `expected an export confirmation, got: ${JSON.stringify(stub.messages)}`
    );
  });

  it('exporting without choosing a folder writes nothing', async () => {
    const exportDir = path.join(root, 'md-export-empty');
    fs.mkdirSync(exportDir, { recursive: true });
    stub.openDialogPaths = [];
    await panel.onMessage!({ type: 'ready' });
    await panel.onMessage!({ type: 'exportSelected', ids: ['ses_bulk2'] });

    assert.strictEqual(fs.readdirSync(exportDir).length, 0);
  });

  it('deletes every child of a parent id and keeps the parent itself', async () => {
    addEventSession(machine, {
      sessionId: 'ses_kid_parent',
      title: 'Kid parent',
      directory: demoDir,
      updated: 1_700_000_400_000,
    });
    for (const n of [1, 2]) {
      addEventSession(machine, {
        sessionId: `ses_kid_child${n}`,
        title: `Kid child ${n}`,
        directory: demoDir,
        parentId: 'ses_kid_parent',
        updated: 1_700_000_400_000 + n,
      });
    }
    stub.warningResponder = () => 'Delete';
    stub.messages.length = 0;
    await panel.onMessage!({ type: 'ready' });
    await panel.onMessage!({ type: 'deleteChildren', parentId: 'ses_kid_parent' });

    const ids = latestState().sessions.map((s: { id: string }) => s.id);
    assert.ok(ids.includes('ses_kid_parent'), 'the parent must survive');
    assert.ok(!ids.includes('ses_kid_child1') && !ids.includes('ses_kid_child2'), 'all children must go');
    assert.ok(
      stub.messages.some((m) => m.kind === 'info' && m.text.includes('Deleted 2 session(s)')),
      `expected a bulk-delete confirmation, got: ${JSON.stringify(stub.messages)}`
    );
  });

  it('warns and deletes nothing when a parent id has no children', async () => {
    stub.messages.length = 0;
    await panel.onMessage!({ type: 'ready' });
    const before = latestState().sessions.length;
    await panel.onMessage!({ type: 'deleteChildren', parentId: 'ses_no_such_parent' });

    assert.strictEqual(latestState().sessions.length, before);
    assert.ok(stub.messages.some((m) => m.kind === 'warn' && m.text.includes('No child sessions')));
  });
});
