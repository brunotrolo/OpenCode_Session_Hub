import * as vscode from 'vscode';
import { DashboardViewProvider } from './dashboardView';
import { generateHandoff } from './handoff';
import { OpenCodeLocations } from './opencodePaths';
import { resolveLocalDirectory } from './pathMapper';
import { showSessionPreview } from './previewPanel';
import { showSessionManager } from './sessionManagerPanel';
import { loadMessages, SessionRecord } from './sessionScanner';
import { SyncStatusBar } from './statusBar';
import { SyncController } from './syncController';
import { SyncError, SyncOutcome } from './syncManager';

let statusBar: SyncStatusBar;
let output: vscode.OutputChannel;
let controller: SyncController;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('OpenCode Session Hub');
  controller = new SyncController(context, output);
  statusBar = new SyncStatusBar(controller.getState().status);
  context.subscriptions.push(output, statusBar, { dispose: () => controller.dispose() });
  context.subscriptions.push(controller.onDidChangeState((state) => statusBar.set(state.status)));

  const dashboard = new DashboardViewProvider(context, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard)
  );

  const register = (name: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  register('opencodeSessionHub.listAllSessions', () => listAllSessions());
  register('opencodeSessionHub.manageSessions', () => showSessionManager(controller));
  register('opencodeSessionHub.previewSession', async () => {
    const locations = controller.getLocations();
    const record = await pickSession('Select a session to preview');
    if (record) {
      showSessionPreview(locations, record);
    }
  });
  register('opencodeSessionHub.searchSessions', () => searchSessions());
  register('opencodeSessionHub.syncInit', () => initOrLink('init'));
  register('opencodeSessionHub.syncLink', () => initOrLink('link'));
  register('opencodeSessionHub.syncPush', () => runSync('push'));
  register('opencodeSessionHub.syncPull', () => runSync('pull'));
  register('opencodeSessionHub.syncStatus', () => showSyncStatus());
  register('opencodeSessionHub.syncResolve', () => resolveConflicts());
  register('opencodeSessionHub.generateHandoff', () => generateHandoffCommand());
  register('opencodeSessionHub.openDashboard', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.opencodeSessionHub');
  });
  register('opencodeSessionHub.showDebugInfo', () => showDebugInfo());
  register('opencodeSessionHub.compactDatabase', () => compactDatabase());
  register('opencodeSessionHub.rebuildMirror', () => rebuildMirror());

  const config = vscode.workspace.getConfiguration('opencodeSessionHub');
  if (config.get<boolean>('autoPullOnStartup', true) && controller.getSettings().remoteUrl) {
    void runSync('pull', { silent: true });
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      const settings = vscode.workspace.getConfiguration('opencodeSessionHub');
      if (state.focused || !settings.get<boolean>('autoSyncOnFocusLost', true)) {
        return;
      }
      if (!controller.getSettings().remoteUrl) {
        return;
      }
      controller.scheduleDebouncedPush(settings.get<number>('debounceSeconds', 20));
    })
  );
}

export function deactivate() {
  controller?.dispose();
}

// ---------------------------------------------------------------- sync ----

async function runSync(direction: 'push' | 'pull', options: { silent?: boolean } = {}): Promise<void> {
  try {
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `OpenCode sync: ${direction}` },
      () => controller.sync(direction, options)
    );
    if (outcome) {
      reportOutcome(direction, outcome, options.silent === true);
    }
  } catch (err) {
    const message = err instanceof SyncError ? err.message : String(err);
    if (!options.silent) {
      vscode.window.showErrorMessage(`OpenCode sync ${direction} failed: ${message}`);
    }
  }
}

function reportOutcome(direction: string, outcome: SyncOutcome, silent: boolean) {
  if (outcome.status === 'conflict') {
    vscode.window.showWarningMessage(outcome.messages.join(' ') || 'OpenCode sync hit a conflict.');
    return;
  }

  // Fail-closed notices must reach the user even on a silent background sync:
  // silently not syncing sessions is exactly the surprise worth avoiding.
  const important = outcome.messages.filter((m) => m.includes('NOT synced') || m.startsWith('Skipped'));
  if (important.length > 0) {
    vscode.window.showWarningMessage(important.join(' '));
  } else if (!silent) {
    vscode.window.showInformationMessage(
      outcome.status === 'no-changes'
        ? `OpenCode sync ${direction}: already up to date.`
        : `OpenCode sync ${direction}: ${outcome.changedFiles} file(s).`
    );
  }
}

async function initOrLink(mode: 'init' | 'link') {
  const current = controller.getSettings();
  const url = await vscode.window.showInputBox({
    prompt:
      mode === 'init'
        ? 'Git URL of the PRIVATE repository to use for syncing (create it first on GitHub/GitLab)'
        : 'Git URL of the existing sync repository to link this machine to',
    value: current.remoteUrl,
    placeHolder: 'git@github.com:you/my-opencode-config.git',
    ignoreFocusOut: true,
  });

  if (!url?.trim()) {
    return;
  }

  try {
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `OpenCode sync: ${mode}` },
      () => controller.initOrLink(url, mode)
    );
    if (outcome) {
      reportOutcome(mode === 'link' ? 'pull' : 'push', outcome, false);
    }
  } catch (err) {
    const message = err instanceof SyncError ? err.message : String(err);
    vscode.window.showErrorMessage(`OpenCode sync ${mode} failed: ${message}`);
  }
}

async function showDebugInfo() {
  const report = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'OpenCode: gathering debug info' },
    () => controller.buildDebugReport()
  );

  output.appendLine('');
  output.appendLine(report);
  output.show(true);
  vscode.window.showInformationMessage('OpenCode Session Hub debug info written to the Output panel.');
}

/**
 * Recovery for a sync repo whose unpushed history GitHub will never accept
 * — most often a blob over its 100 MB limit, which makes every push fail
 * with no way forward otherwise. Confirmed first because it does discard
 * local commits, but the confirmation says plainly what is and isn't at
 * risk: the mirror is a scratch copy, so no session data and nothing
 * already on GitHub can be lost.
 */
async function rebuildMirror() {
  const choice = await vscode.window.showWarningMessage(
    'Rebuild the local sync mirror from the remote? Any commits made here but never pushed will be discarded — ' +
      'that is usually the point, since this exists to clear history GitHub refuses to accept. Your OpenCode ' +
      'sessions and everything already on GitHub are NOT touched; the mirror is only a scratch copy and the ' +
      'next push re-uploads this machine\'s current state.',
    { modal: true },
    'Rebuild Mirror'
  );
  if (choice !== 'Rebuild Mirror') {
    return;
  }

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'OpenCode: rebuilding the sync mirror' },
      () => controller.rebuildMirror()
    );
    vscode.window.showInformationMessage(
      `OpenCode Session Hub: mirror rebuilt${
        result.discardedCommits > 0 ? ` (${result.discardedCommits} unpushed commit(s) discarded)` : ''
      }. Run "Push Now" to upload this machine's current state.`
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `OpenCode Session Hub: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * VACUUM needs SQLite to treat the connection as exclusive enough to rewrite
 * the whole file, so this can't safely run while OpenCode has the database
 * open and active — hence the modal warning rather than just doing it.
 */
async function compactDatabase() {
  const databasePath = controller.getLocations().databasePath;
  const choice = await vscode.window.showWarningMessage(
    `Compact opencode.db (${databasePath})? Close OpenCode first — this rewrites the whole file and can take a ` +
      "while for a large database. This only shrinks the file on disk; it doesn't sync anything by itself.",
    { modal: true },
    'Compact'
  );
  if (choice !== 'Compact') {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'OpenCode: compacting opencode.db (VACUUM)' },
    () => controller.compactDatabase()
  );

  if (!result.ok) {
    vscode.window.showErrorMessage(`OpenCode Session Hub: ${result.error}`);
    return;
  }

  const beforeMb = (result.beforeBytes / (1024 * 1024)).toFixed(0);
  const afterMb = (result.afterBytes / (1024 * 1024)).toFixed(0);
  const walBeforeMb = (result.walBeforeBytes / (1024 * 1024)).toFixed(0);
  const walAfterMb = (result.walAfterBytes / (1024 * 1024)).toFixed(0);
  const walSummary = result.walBeforeBytes > 0 || result.walAfterBytes > 0 ? `, WAL ${walBeforeMb} MB -> ${walAfterMb} MB` : '';

  vscode.window.showInformationMessage(
    `opencode.db compacted: ${beforeMb} MB -> ${afterMb} MB${walSummary}. Run "Push Now" to sync the smaller database.`
  );

  if (result.walWarning) {
    vscode.window.showWarningMessage(`OpenCode Session Hub: ${result.walWarning}`);
  }
}

async function showSyncStatus() {
  if (!controller.getSettings().remoteUrl) {
    vscode.window.showWarningMessage('OpenCode sync is not configured.');
    return;
  }

  const status = await controller.refreshStatus();
  if (!status) {
    const state = controller.getState();
    vscode.window.showErrorMessage(`Could not read sync status: ${state.lastError ?? 'unknown error'}`);
    return;
  }

  vscode.window.showInformationMessage(
    `OpenCode sync [${status.branch}] — ${status.ahead} ahead, ${status.behind} behind` +
      `${status.dirty ? ', local changes pending' : ''}${status.conflicted ? ', CONFLICTED' : ''}`
  );
}

async function resolveConflicts() {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Keep this machine’s version', keep: 'local' as const },
      { label: 'Keep the synced (remote) version', keep: 'remote' as const },
    ],
    { placeHolder: 'Which side should win for every conflicted file?' }
  );
  if (!choice) {
    return;
  }

  try {
    const outcome = await controller.resolveConflicts(choice.keep);
    vscode.window.showInformationMessage(outcome.messages.join(' '));
  } catch (err) {
    const message = err instanceof SyncError ? err.message : String(err);
    vscode.window.showErrorMessage(`Could not resolve conflicts: ${message}`);
  }
}

// ------------------------------------------------------------ sessions ----

async function listAllSessions() {
  const locations = controller.getLocations();
  const record = await pickSession('Select an OpenCode session from any project on this machine');
  if (!record) {
    return;
  }

  const localDir = resolveLocalDirectory(record.directory, {
    mappings: controller.getMappings(),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    searchRoots: vscode.workspace.getConfiguration('opencodeSessionHub').get<string[]>('projectSearchRoots', []),
  });

  if (!localDir) {
    const choice = await vscode.window.showWarningMessage(
      `"${record.directory || 'unknown'}" does not exist on this machine. It was probably recorded on another one.`,
      'Preview Conversation',
      'Pick Folder…'
    );
    if (choice === 'Preview Conversation') {
      showSessionPreview(locations, record);
    } else if (choice === 'Pick Folder…') {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false });
      if (picked?.[0]) {
        await offerSessionActions(locations, record, picked[0].fsPath);
      }
    }
    return;
  }

  await offerSessionActions(locations, record, localDir);
}

async function offerSessionActions(locations: OpenCodeLocations, record: SessionRecord, directory: string) {
  const action = await vscode.window.showQuickPick(
    [
      { label: '$(terminal) Resume in Terminal', action: 'terminal' as const },
      { label: '$(preview) Preview Conversation', action: 'preview' as const },
      { label: '$(folder-opened) Open Folder in New Window', action: 'openFolder' as const },
      { label: '$(note) Generate Handoff Checkpoint', action: 'handoff' as const },
      { label: '$(trash) Delete Session', action: 'delete' as const },
    ],
    { placeHolder: `${record.title} — ${directory}` }
  );

  switch (action?.action) {
    case 'terminal':
      openInTerminal(record, directory);
      break;
    case 'preview':
      showSessionPreview(locations, record);
      break;
    case 'openFolder':
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(directory), {
        forceNewWindow: true,
      });
      break;
    case 'handoff':
      writeHandoff(locations, record, directory);
      break;
    case 'delete':
      await deleteSessionCommand(record);
      break;
    default:
      break;
  }
}

/**
 * Local-only, same as the dashboard's Delete button: removes the session's
 * own files and any favorite bookmarking it, but never touches the sync
 * repo or another machine's copy (session dirs merge rather than mirror on
 * purpose, so nothing here is asked to propagate a deletion).
 */
async function deleteSessionCommand(record: SessionRecord) {
  const choice = await vscode.window.showWarningMessage(
    `Delete "${record.title}" (${record.messageCount} messages) from this machine? This cannot be undone here, and will not remove it from the sync repository or other machines if it was already synced.`,
    { modal: true },
    'Delete'
  );
  if (choice !== 'Delete') {
    return;
  }
  try {
    await controller.deleteSession(record);
  } catch (err) {
    vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  vscode.window.showInformationMessage(`Deleted "${record.title}".`);
}

function openInTerminal(record: SessionRecord, directory: string) {
  // cwd on the terminal itself avoids a `cd` that would break under
  // PowerShell 5, where `&&` is not a valid statement separator.
  const terminal = vscode.window.createTerminal({ name: `OpenCode: ${record.title}`, cwd: directory });
  terminal.show();
  terminal.sendText(`opencode --session ${record.id}`);
}

async function generateHandoffCommand() {
  const locations = controller.getLocations();
  const record = await pickSession('Select a session to checkpoint');
  if (!record) {
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('Open a workspace folder to write a handoff checkpoint.');
    return;
  }
  writeHandoff(locations, record, workspaceRoot);
}

function writeHandoff(locations: OpenCodeLocations, record: SessionRecord, workspaceRoot: string) {
  try {
    const filePath = generateHandoff(locations, record, workspaceRoot);
    vscode.window.showInformationMessage(`Handoff written to ${filePath}`);
    if (controller.getSettings().remoteUrl) {
      controller.scheduleDebouncedPush(vscode.workspace.getConfiguration('opencodeSessionHub').get<number>('debounceSeconds', 20));
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Could not write handoff: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function searchSessions() {
  const query = await vscode.window.showInputBox({
    prompt: 'Search every OpenCode session on this machine',
    placeHolder: 'e.g. regex for parsing dates',
  });
  if (!query?.trim()) {
    return;
  }

  const locations = controller.getLocations();
  const needle = query.toLowerCase();

  const matches = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Searching OpenCode history…' },
    async () => {
      const found: { record: SessionRecord; snippet: string }[] = [];
      for (const record of controller.listSessions().sessions) {
        for (const message of loadMessages(locations, record)) {
          const index = message.text.toLowerCase().indexOf(needle);
          if (index >= 0) {
            found.push({
              record,
              snippet: message.text.slice(Math.max(0, index - 40), index + 80).replace(/\s+/g, ' '),
            });
            break;
          }
        }
      }
      return found;
    }
  );

  if (matches.length === 0) {
    vscode.window.showInformationMessage(`No sessions matched "${query}".`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    matches.map((m) => ({
      label: m.record.title,
      description: m.record.directory,
      detail: `…${m.snippet}…`,
      record: m.record,
    })),
    { placeHolder: `${matches.length} session(s) matched "${query}"` }
  );

  if (picked) {
    showSessionPreview(locations, picked.record);
  }
}

async function pickSession(placeHolder: string): Promise<SessionRecord | undefined> {
  const { sessions, warnings } = controller.listSessions();
  for (const warning of warnings) {
    output.appendLine(`[${new Date().toISOString()}] ${warning}`);
    vscode.window.showWarningMessage(warning);
  }

  if (sessions.length === 0) {
    vscode.window.showInformationMessage(
      `No OpenCode sessions found under ${controller.getLocations().dataRoot}. Set opencodeSessionHub.dataPath if OpenCode stores data elsewhere.`
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    sessions.map((session) => ({
      label: session.title,
      description: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : '',
      detail: `${session.directory || 'unknown directory'} · ${session.messageCount} messages · ${session.source}`,
      record: session,
    })),
    { placeHolder, matchOnDetail: true }
  );

  return picked?.record;
}
