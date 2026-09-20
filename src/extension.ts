import * as vscode from 'vscode';
import { findAllSessions, loadSessionMessages, SessionRecord } from './sessionScanner';
import { getOpenCodeStorageRoot } from './storagePaths';
import { resolveLocalDirectory } from './pathMapper';
import { SyncManager } from './syncManager';
import { SyncStatusBar } from './statusBar';
import { showSessionPreview } from './previewPanel';
import { generateHandoffForActiveWorkspace } from './handoff';

export function activate(context: vscode.ExtensionContext) {
  const syncManager = new SyncManager(context);
  const statusBar = new SyncStatusBar();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(syncManager.onDidChangeStatus((s) => statusBar.set(s)));

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeSessionHub.listAllSessions', () => listAllSessionsCommand())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeSessionHub.previewSession', async () => {
      const record = await pickSession('Select a session to preview');
      if (record) {
        showSessionPreview(record);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeSessionHub.searchSessions', () => searchSessionsCommand())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeSessionHub.syncInit', async () => {
      try {
        await syncManager.initSyncRepo();
        vscode.window.showInformationMessage('OpenCode sync repository initialized.');
      } catch (err) {
        vscode.window.showErrorMessage(`OpenCode sync init failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeSessionHub.syncPush', async () => {
      try {
        await syncManager.push();
        vscode.window.showInformationMessage('OpenCode sessions pushed.');
      } catch (err) {
        vscode.window.showErrorMessage(`OpenCode sync push failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeSessionHub.syncPull', async () => {
      try {
        await syncManager.pull();
        vscode.window.showInformationMessage('OpenCode sessions pulled.');
      } catch (err) {
        vscode.window.showErrorMessage(`OpenCode sync pull failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeSessionHub.generateHandoff', async () => {
      const record = await pickSession('Select a session to checkpoint');
      if (!record) {
        return;
      }
      const filePath = await generateHandoffForActiveWorkspace(record);
      if (filePath) {
        vscode.window.showInformationMessage(`Handoff written to ${filePath}`);
        syncManager.scheduleDebouncedPush();
      }
    })
  );

  // "Google Drive"-style automation: pull on startup, push (debounced) on blur.
  const config = vscode.workspace.getConfiguration('opencodeSessionHub');
  if (config.get<boolean>('autoPullOnStartup', true)) {
    syncManager.pull().catch((err) => console.error('[OpenCode Session Hub] startup pull failed', err));
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused && vscode.workspace.getConfiguration('opencodeSessionHub').get<boolean>('autoSyncOnFocusLost', true)) {
        syncManager.scheduleDebouncedPush();
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      // Best-effort final push on deactivation; fire-and-forget.
      syncManager.push().catch(() => undefined);
    },
  });
}

export function deactivate() {
  // Cleanup handled via context.subscriptions in activate().
}

async function listAllSessionsCommand() {
  const record = await pickSession('Select an OpenCode session from any project on this machine');
  if (!record) {
    return;
  }

  const localDir = resolveLocalDirectory(record.directory);
  if (!localDir) {
    const choice = await vscode.window.showWarningMessage(
      `Could not find "${record.directory}" on this machine. Open it anyway with the original path?`,
      'Open Terminal Anyway',
      'Preview Instead',
      'Cancel'
    );
    if (choice === 'Preview Instead') {
      showSessionPreview(record);
    } else if (choice === 'Open Terminal Anyway') {
      openInTerminal(record, record.directory);
    }
    return;
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(terminal) Resume in Terminal', action: 'terminal' as const },
      { label: '$(preview) Preview Conversation', action: 'preview' as const },
      { label: '$(folder-opened) Open Folder in New Window', action: 'openFolder' as const },
    ],
    { placeHolder: `${record.title} — ${localDir}` }
  );

  if (!action) {
    return;
  }

  if (action.action === 'terminal') {
    openInTerminal(record, localDir);
  } else if (action.action === 'preview') {
    showSessionPreview(record);
  } else {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(localDir), { forceNewWindow: true });
  }
}

function openInTerminal(record: SessionRecord, directory: string) {
  const terminal = vscode.window.createTerminal(`OpenCode: ${record.title}`);
  terminal.show();
  terminal.sendText(`cd "${directory}" && opencode --session ${record.id}`);
}

async function searchSessionsCommand() {
  const query = await vscode.window.showInputBox({
    prompt: 'Search all OpenCode session history on this machine',
    placeHolder: 'e.g. regex for parsing dates',
  });
  if (!query) {
    return;
  }

  const sessions = findAllSessions(getOpenCodeStorageRoot());
  const matches: { record: SessionRecord; snippet: string }[] = [];

  for (const record of sessions) {
    const messages = loadSessionMessages(record);
    for (const msg of messages) {
      const text = typeof msg.text === 'string' ? msg.text : typeof msg.content === 'string' ? msg.content : '';
      const index = text.toLowerCase().indexOf(query.toLowerCase());
      if (index >= 0) {
        matches.push({ record, snippet: text.slice(Math.max(0, index - 40), index + 80) });
        break;
      }
    }
  }

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
    showSessionPreview(picked.record);
  }
}

async function pickSession(placeHolder: string): Promise<SessionRecord | undefined> {
  const sessions = findAllSessions(getOpenCodeStorageRoot());
  if (sessions.length === 0) {
    vscode.window.showInformationMessage('No OpenCode sessions found on this machine.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    sessions.map((s) => ({
      label: s.title,
      description: new Date(s.updatedAt).toLocaleString(),
      detail: `${s.directory} · ${s.messageCount} messages · id ${s.id}`,
      record: s,
    })),
    { placeHolder }
  );

  return picked?.record;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
