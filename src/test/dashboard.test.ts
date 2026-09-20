import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { addStorageSession, createMachine, FakeMachine } from './fixtures';
import { installVscodeStub, StubState } from './vscodeStub';

/**
 * Drives the sidebar dashboard's webview message protocol directly — the
 * same messages the HTML/JS in dashboardView.ts posts when a user clicks a
 * button — against a real SyncController and a real two-machine sync repo.
 */
describe('sidebar dashboard', () => {
  let root: string;
  let remote: string;
  let machine: FakeMachine;
  let stub: StubState;
  let DashboardViewProvider: typeof import('../dashboardView').DashboardViewProvider;
  let SyncController: typeof import('../syncController').SyncController;
  let provider: InstanceType<typeof DashboardViewProvider>;
  let controller: InstanceType<typeof SyncController>;
  let posted: unknown[];
  let onMessage: (message: unknown) => void;

  function context() {
    return { globalStorageUri: { fsPath: path.join(machine.home, 'globalStorage') } };
  }

  function fakeWebviewView() {
    posted = [];
    return {
      webview: {
        options: {},
        cspSource: 'vscode-webview:',
        html: '',
        postMessage: async (msg: unknown) => {
          posted.push(msg);
          return true;
        },
        onDidReceiveMessage: (cb: (m: unknown) => void) => {
          onMessage = cb;
          return { dispose: () => undefined };
        },
      },
      onDidDispose: () => ({ dispose: () => undefined }),
    };
  }

  function latestState(): any {
    const stateMsgs = posted.filter((m: any) => m.type === 'state');
    return stateMsgs[stateMsgs.length - 1];
  }

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-dash-'));
    remote = path.join(root, 'remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    machine = createMachine(root, 'work');

    addStorageSession(machine, {
      projectId: 'prj_a',
      sessionId: 'ses_dash1',
      title: 'Dashboard demo session',
      worktree: '/work/demo',
    });

    stub = installVscodeStub();
    stub.config['dataPath'] = machine.dataRoot;

    DashboardViewProvider = require('../dashboardView').DashboardViewProvider;
    SyncController = require('../syncController').SyncController;
  });

  beforeEach(() => {
    const output = { appendLine: () => undefined, dispose: () => undefined };
    controller = new SyncController(context() as never, output as never);
    provider = new DashboardViewProvider(context() as never, controller);
    provider.resolveWebviewView(fakeWebviewView() as never);
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports unconfigured status until a remote is saved', async () => {
    await onMessage({ type: 'ready' });
    const state = latestState();
    assert.strictEqual(state.state.status, 'unconfigured');
    assert.strictEqual(state.sessionCount, 1);
    assert.strictEqual(state.sessions[0].title, 'Dashboard demo session');
  });

  it('saving the connection flips status to idle', async () => {
    await onMessage({ type: 'saveConnection', remoteUrl: remote, branch: 'main' });
    const state = latestState();
    assert.strictEqual(state.state.status, 'idle');
    assert.strictEqual(state.settings.remoteUrl, remote);
  });

  it('push runs a real sync and updates health', async () => {
    await onMessage({ type: 'saveConnection', remoteUrl: remote, branch: 'main' });
    await onMessage({ type: 'push' });
    const state = latestState();
    assert.strictEqual(state.state.status, 'idle');
    assert.ok(state.state.lastSyncAt);
  });

  it('fails closed: enabling includeSecrets without acknowledging privacy is rejected', async () => {
    await onMessage({ type: 'saveConnection', remoteUrl: remote, branch: 'main' });
    await onMessage({
      type: 'saveSecurity',
      includeSecrets: true,
      privateRepoAcknowledged: false,
      includeSessions: true,
      redactSecrets: true,
    });

    const state = latestState();
    assert.strictEqual(state.settings.includeSecrets, false);
    assert.strictEqual(state.settings.privateRepoAcknowledged, false);

    await onMessage({ type: 'push' });
    const afterPush = latestState();
    assert.ok(
      afterPush.state.lastOutcome.messages.some((m: string) => m.includes('NOT synced')),
      'expected the fail-closed notice in the push outcome'
    );
  });

  it('enabling both security boxes together allows session sync', async () => {
    await onMessage({ type: 'saveConnection', remoteUrl: remote, branch: 'main' });
    await onMessage({
      type: 'saveSecurity',
      includeSecrets: true,
      privateRepoAcknowledged: true,
      includeSessions: true,
      redactSecrets: true,
    });

    const state = latestState();
    assert.strictEqual(state.settings.includeSecrets, true);
    assert.strictEqual(state.settings.privateRepoAcknowledged, true);
  });

  it('saving the schedule persists debounce and toggle settings', async () => {
    await onMessage({
      type: 'saveSchedule',
      debounceSeconds: 45,
      autoPullOnStartup: false,
      autoSyncOnFocusLost: true,
    });

    const state = latestState();
    assert.strictEqual(state.schedule.debounceSeconds, 45);
    assert.strictEqual(state.schedule.autoPullOnStartup, false);
  });

  it('resume posts a terminal running opencode --session <id>', async () => {
    await onMessage({ type: 'refresh' });
    await onMessage({ type: 'resumeSession', id: 'ses_dash1' });

    assert.strictEqual(stub.terminals.length, 1);
    assert.strictEqual(stub.terminals[0].cwd, '/work/demo');
    assert.deepStrictEqual(stub.terminals[0].sent, ['opencode --session ses_dash1']);
  });

  it('preview opens a webview for the selected session', async () => {
    stub.webviews.length = 0;
    await onMessage({ type: 'refresh' });
    await onMessage({ type: 'previewSession', id: 'ses_dash1' });

    assert.strictEqual(stub.webviews.length, 1);
    assert.ok(stub.webviews[0].html.includes('Dashboard demo session'));
  });

  it('does not throw when acting on an unknown session id', async () => {
    stub.terminals.length = 0;
    await onMessage({ type: 'resumeSession', id: 'does-not-exist' });
    assert.strictEqual(stub.terminals.length, 0);
  });

  it('surfaces a sync error to the state instead of throwing out of the handler', async () => {
    await onMessage({ type: 'saveConnection', remoteUrl: 'file:///definitely/not/a/repo', branch: 'main' });
    await onMessage({ type: 'push' });
    const state = latestState();
    assert.strictEqual(state.state.status, 'error');
    assert.ok(state.state.lastError);
  });
});
