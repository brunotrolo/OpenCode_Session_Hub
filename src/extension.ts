import * as path from 'path';
import * as vscode from 'vscode';
import { generateHandoff } from './handoff';
import { OpenCodeLocations, resolveOpenCodeLocations } from './opencodePaths';
import { DirectoryMapping, resolveLocalDirectory } from './pathMapper';
import { showSessionPreview } from './previewPanel';
import { loadMessages, scanSessions, SessionRecord } from './sessionScanner';
import { SyncStatusBar } from './statusBar';
import { SyncError, SyncManager, SyncOutcome, SyncSettings, SyncStatus } from './syncManager';

let debounceTimer: NodeJS.Timeout | undefined;
let statusBar: SyncStatusBar;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('OpenCode Session Hub');
  statusBar = new SyncStatusBar(readSettings(context).remoteUrl ? 'idle' : 'unconfigured');
  context.subscriptions.push(output, statusBar);

  const register = (name: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  register('opencodeSessionHub.listAllSessions', () => listAllSessions(context));
  register('opencodeSessionHub.previewSession', async () => {
    const locations = getLocations();
    const record = await pickSession(locations, 'Select a session to preview');
    if (record) {
      showSessionPreview(locations, record);
    }
  });
  register('opencodeSessionHub.searchSessions', () => searchSessions());
  register('opencodeSessionHub.syncInit', () => initOrLink(context, 'init'));
  register('opencodeSessionHub.syncLink', () => initOrLink(context, 'link'));
  register('opencodeSessionHub.syncPush', () => runSync(context, 'push'));
  register('opencodeSessionHub.syncPull', () => runSync(context, 'pull'));
  register('opencodeSessionHub.syncStatus', () => showSyncStatus(context));
  register('opencodeSessionHub.syncResolve', () => resolveConflicts(context));
  register('opencodeSessionHub.generateHandoff', () => generateHandoffCommand(context));

  const config = vscode.workspace.getConfiguration('opencodeSessionHub');
  if (config.get<boolean>('autoPullOnStartup', true) && readSettings(context).remoteUrl) {
    void runSync(context, 'pull', { silent: true });
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      const settings = vscode.workspace.getConfiguration('opencodeSessionHub');
      if (state.focused || !settings.get<boolean>('autoSyncOnFocusLost', true)) {
        return;
      }
      if (!readSettings(context).remoteUrl) {
        return;
      }
      scheduleDebouncedPush(context, settings.get<number>('debounceSeconds', 20));
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
    },
  });
}

export function deactivate() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}

// ------------------------------------------------------------- settings ---

function getLocations(): OpenCodeLocations {
  const override = vscode.workspace
    .getConfiguration('opencodeSessionHub')
    .get<string>('dataPath', '')
    .trim();
  return resolveOpenCodeLocations(process.env, process.platform, override || undefined);
}

function readSettings(context: vscode.ExtensionContext): SyncSettings {
  const config = vscode.workspace.getConfiguration('opencodeSessionHub');
  const repoDir = config.get<string>('syncRepoPath', '').trim();

  return {
    remoteUrl: config.get<string>('syncRemoteUrl', '').trim(),
    branch: config.get<string>('syncBranch', 'main').trim() || 'main',
    repoDir: repoDir || path.join(context.globalStorageUri.fsPath, 'sync-repo'),
    includeSecrets: config.get<boolean>('includeSecrets', false),
    includeSessions: config.get<boolean>('includeSessions', true),
    includeModelFavorites: config.get<boolean>('includeModelFavorites', true),
    includeOpencodeSkills: config.get<boolean>('includeOpencodeSkills', true),
    includeAgentsDir: config.get<boolean>('includeAgentsDir', true),
    redactSecrets: config.get<boolean>('redactSecrets', true),
    privateRepoAcknowledged: config.get<boolean>('privateRepoAcknowledged', false),
  };
}

function getMappings(): DirectoryMapping[] {
  const raw = vscode.workspace
    .getConfiguration('opencodeSessionHub')
    .get<DirectoryMapping[]>('directoryMappings', []);
  return raw.filter((entry) => entry && typeof entry.from === 'string' && typeof entry.to === 'string');
}

// ---------------------------------------------------------------- sync ----

function scheduleDebouncedPush(context: vscode.ExtensionContext, seconds: number) {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    void runSync(context, 'push', { silent: true });
  }, Math.max(1, seconds) * 1000);
}

async function runSync(
  context: vscode.ExtensionContext,
  direction: 'push' | 'pull',
  options: { silent?: boolean } = {}
): Promise<void> {
  const settings = readSettings(context);
  if (!settings.remoteUrl) {
    setStatus('unconfigured');
    if (!options.silent) {
      vscode.window.showWarningMessage('Set opencodeSessionHub.syncRemoteUrl first, or run "OpenCode Sync: Initialize Sync Repository".');
    }
    return;
  }

  const manager = new SyncManager(getLocations(), settings);
  setStatus('syncing');

  try {
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `OpenCode sync: ${direction}` },
      () => (direction === 'push' ? manager.push() : manager.pull())
    );
    reportOutcome(direction, outcome, options.silent === true);
  } catch (err) {
    setStatus('error');
    const message = err instanceof SyncError ? err.message : String(err);
    output.appendLine(`[${new Date().toISOString()}] ${direction} failed: ${message}`);
    if (!options.silent) {
      vscode.window.showErrorMessage(`OpenCode sync ${direction} failed: ${message}`);
    }
  }
}

function reportOutcome(direction: string, outcome: SyncOutcome, silent: boolean) {
  for (const message of outcome.messages) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  if (outcome.status === 'conflict') {
    setStatus('conflict');
    vscode.window.showWarningMessage(outcome.messages.join(' ') || 'OpenCode sync hit a conflict.');
    return;
  }

  setStatus('idle');
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

function setStatus(status: SyncStatus) {
  statusBar?.set(status);
}

async function initOrLink(context: vscode.ExtensionContext, mode: 'init' | 'link') {
  const current = readSettings(context);
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

  await vscode.workspace
    .getConfiguration('opencodeSessionHub')
    .update('syncRemoteUrl', url.trim(), vscode.ConfigurationTarget.Global);

  // Linking adopts the remote's state; initializing publishes this machine's.
  await runSync(context, mode === 'link' ? 'pull' : 'push');
}

async function showSyncStatus(context: vscode.ExtensionContext) {
  const settings = readSettings(context);
  if (!settings.remoteUrl) {
    vscode.window.showWarningMessage('OpenCode sync is not configured.');
    return;
  }

  try {
    const status = await new SyncManager(getLocations(), settings).status();
    vscode.window.showInformationMessage(
      `OpenCode sync [${status.branch}] — ${status.ahead} ahead, ${status.behind} behind` +
        `${status.dirty ? ', local changes pending' : ''}${status.conflicted ? ', CONFLICTED' : ''}`
    );
    setStatus(status.conflicted ? 'conflict' : 'idle');
  } catch (err) {
    setStatus('error');
    vscode.window.showErrorMessage(`Could not read sync status: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolveConflicts(context: vscode.ExtensionContext) {
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
    const outcome = await new SyncManager(getLocations(), readSettings(context)).resolveConflicts(choice.keep);
    vscode.window.showInformationMessage(outcome.messages.join(' '));
    setStatus('idle');
  } catch (err) {
    setStatus('error');
    vscode.window.showErrorMessage(`Could not resolve conflicts: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ------------------------------------------------------------ sessions ----

async function listAllSessions(context: vscode.ExtensionContext) {
  const locations = getLocations();
  const record = await pickSession(locations, 'Select an OpenCode session from any project on this machine');
  if (!record) {
    return;
  }

  const localDir = resolveLocalDirectory(record.directory, {
    mappings: getMappings(),
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
        await offerSessionActions(locations, record, picked[0].fsPath, context);
      }
    }
    return;
  }

  await offerSessionActions(locations, record, localDir, context);
}

async function offerSessionActions(
  locations: OpenCodeLocations,
  record: SessionRecord,
  directory: string,
  context: vscode.ExtensionContext
) {
  const action = await vscode.window.showQuickPick(
    [
      { label: '$(terminal) Resume in Terminal', action: 'terminal' as const },
      { label: '$(preview) Preview Conversation', action: 'preview' as const },
      { label: '$(folder-opened) Open Folder in New Window', action: 'openFolder' as const },
      { label: '$(note) Generate Handoff Checkpoint', action: 'handoff' as const },
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
      writeHandoff(locations, record, directory, context);
      break;
    default:
      break;
  }
}

function openInTerminal(record: SessionRecord, directory: string) {
  // cwd on the terminal itself avoids a `cd` that would break under
  // PowerShell 5, where `&&` is not a valid statement separator.
  const terminal = vscode.window.createTerminal({ name: `OpenCode: ${record.title}`, cwd: directory });
  terminal.show();
  terminal.sendText(`opencode --session ${record.id}`);
}

async function generateHandoffCommand(context: vscode.ExtensionContext) {
  const locations = getLocations();
  const record = await pickSession(locations, 'Select a session to checkpoint');
  if (!record) {
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('Open a workspace folder to write a handoff checkpoint.');
    return;
  }
  writeHandoff(locations, record, workspaceRoot, context);
}

function writeHandoff(
  locations: OpenCodeLocations,
  record: SessionRecord,
  workspaceRoot: string,
  context: vscode.ExtensionContext
) {
  try {
    const filePath = generateHandoff(locations, record, workspaceRoot);
    vscode.window.showInformationMessage(`Handoff written to ${filePath}`);
    if (readSettings(context).remoteUrl) {
      scheduleDebouncedPush(context, vscode.workspace.getConfiguration('opencodeSessionHub').get<number>('debounceSeconds', 20));
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

  const locations = getLocations();
  const needle = query.toLowerCase();

  const matches = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Searching OpenCode history…' },
    async () => {
      const found: { record: SessionRecord; snippet: string }[] = [];
      for (const record of scanSessions(locations).sessions) {
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

async function pickSession(locations: OpenCodeLocations, placeHolder: string): Promise<SessionRecord | undefined> {
  const { sessions, warnings } = scanSessions(locations);
  for (const warning of warnings) {
    output.appendLine(`[${new Date().toISOString()}] ${warning}`);
    vscode.window.showWarningMessage(warning);
  }

  if (sessions.length === 0) {
    vscode.window.showInformationMessage(
      `No OpenCode sessions found under ${locations.dataRoot}. Set opencodeSessionHub.dataPath if OpenCode stores data elsewhere.`
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
