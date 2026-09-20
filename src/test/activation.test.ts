import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { addStorageSession, createMachine, FakeMachine } from './fixtures';
import { installVscodeStub, setWorkspaceFolders, StubState } from './vscodeStub';

/**
 * Simulates the extension host: activates the real extension.ts against a
 * stubbed VS Code API and drives its commands the way a user would.
 */
describe('extension activation and commands', () => {
  let root: string;
  let machine: FakeMachine;
  let stub: StubState;
  let extension: typeof import('../extension');
  let manifest: { contributes: { commands: { command: string }[]; configuration: { properties: Record<string, unknown> } } };

  const context = () => ({
    subscriptions: [] as { dispose(): void }[],
    globalStorageUri: { fsPath: path.join(root, 'globalStorage') },
  });

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-activate-'));
    machine = createMachine(root, 'workstation');

    addStorageSession(machine, {
      projectId: 'prj_alpha',
      sessionId: 'ses_demo',
      title: 'Demo session',
      worktree: path.join(root, 'projects', 'demo'),
      messages: [{ id: 'msg_1', role: 'user', text: 'find the covering index trick', created: 1_700_000_200_000 }],
    });
    fs.mkdirSync(path.join(root, 'projects', 'demo'), { recursive: true });

    stub = installVscodeStub();
    stub.config['dataPath'] = machine.dataRoot;
    stub.config['autoPullOnStartup'] = false;

    manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    extension = require('../extension');
    extension.activate(context() as never);
  });

  after(() => {
    extension.deactivate();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('registers every command declared in package.json', () => {
    const declared = manifest.contributes.commands.map((c) => c.command).sort();
    const registered = [...stub.commands.keys()].sort();
    assert.deepStrictEqual(registered, declared);
  });

  it('declares a setting for every configuration key the code reads', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
    const used = new Set<string>();
    for (const match of source.matchAll(/get<[^>]+>\('([A-Za-z]+)'/g)) {
      used.add(`opencodeSessionHub.${match[1]}`);
    }

    const declared = new Set(Object.keys(manifest.contributes.configuration.properties));
    const missing = [...used].filter((key) => !declared.has(key));
    assert.deepStrictEqual(missing, [], `settings read but not declared: ${missing.join(', ')}`);
  });

  it('starts in the unconfigured state when no remote is set', () => {
    assert.ok(stub.statusBar.text.includes('OpenCode'));
    assert.ok(stub.statusBar.tooltip.includes('not configured'));
  });

  it('lists sessions and resumes the selected one in a terminal', async () => {
    stub.quickPickResponder = (items) => {
      const list = items as { label: string; action?: string; record?: unknown }[];
      // First prompt picks the session, second picks the action.
      return list.find((item) => item.action === 'terminal') ?? list[0];
    };

    await stub.commands.get('opencodeSessionHub.listAllSessions')!();

    assert.strictEqual(stub.terminals.length, 1);
    assert.strictEqual(stub.terminals[0].cwd, path.join(root, 'projects', 'demo'));
    assert.deepStrictEqual(stub.terminals[0].sent, ['opencode --session ses_demo']);
  });

  it('previews a session in a webview without executing scripts', async () => {
    stub.quickPickResponder = (items) => (items as unknown[])[0];
    await stub.commands.get('opencodeSessionHub.previewSession')!();

    assert.strictEqual(stub.webviews.length, 1);
    assert.ok(stub.webviews[0].html.includes('Demo session'));
    assert.ok(stub.webviews[0].html.includes('find the covering index trick'));
    assert.ok(stub.webviews[0].html.includes("default-src 'none'"));
  });

  it('searches across all session history', async () => {
    stub.inputResponder = () => 'covering index';
    let offered: { label: string }[] = [];
    stub.quickPickResponder = (items) => {
      offered = items as { label: string }[];
      return undefined;
    };

    await stub.commands.get('opencodeSessionHub.searchSessions')!();
    assert.deepStrictEqual(offered.map((item) => item.label), ['Demo session']);
  });

  it('reports no match without throwing', async () => {
    stub.inputResponder = () => 'nothing-matches-this-string';
    stub.messages.length = 0;
    await stub.commands.get('opencodeSessionHub.searchSessions')!();
    assert.ok(stub.messages.some((m) => m.text.includes('No sessions matched')));
  });

  it('writes a handoff checkpoint into the open workspace', async () => {
    const workspace = path.join(root, 'projects', 'demo');
    setWorkspaceFolders([workspace]);
    stub.quickPickResponder = (items) => (items as unknown[])[0];

    await stub.commands.get('opencodeSessionHub.generateHandoff')!();

    const handoff = path.join(workspace, '.opencode', 'HANDOFF.md');
    assert.ok(fs.existsSync(handoff));
    assert.ok(fs.readFileSync(handoff, 'utf8').includes('Demo session'));
  });

  it('refuses to sync before a remote is configured instead of throwing', async () => {
    stub.messages.length = 0;
    await stub.commands.get('opencodeSessionHub.syncPush')!();
    assert.ok(stub.messages.some((m) => m.kind === 'warn' && m.text.includes('syncRemoteUrl')));
  });

  it('cancels cleanly when the user dismisses the session picker', async () => {
    stub.quickPickResponder = () => undefined;
    await stub.commands.get('opencodeSessionHub.listAllSessions')!();
    assert.strictEqual(stub.terminals.length, 1, 'no extra terminal should be created on cancel');
  });
});
