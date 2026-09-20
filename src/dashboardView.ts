import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { resolveLocalDirectory } from './pathMapper';
import { showSessionPreview } from './previewPanel';
import { SessionRecord } from './sessionScanner';
import { SyncController } from './syncController';
import { SyncError } from './syncManager';

type Inbound =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'push' }
  | { type: 'pull' }
  | { type: 'resolve'; keep: 'local' | 'remote' }
  | { type: 'saveConnection'; remoteUrl: string; branch: string }
  | {
      type: 'saveSchedule';
      debounceSeconds: number;
      autoPullOnStartup: boolean;
      autoSyncOnFocusLost: boolean;
    }
  | {
      type: 'saveSecurity';
      includeSecrets: boolean;
      privateRepoAcknowledged: boolean;
      includeSessions: boolean;
      redactSecrets: boolean;
    }
  | { type: 'previewSession'; id: string }
  | { type: 'resumeSession'; id: string }
  | { type: 'openFullList' }
  | { type: 'saveFavorite'; label: string; sessionId: string }
  | { type: 'removeFavorite'; id: string }
  | { type: 'previewFavorite'; sessionId: string }
  | { type: 'resumeFavorite'; sessionId: string };

/**
 * Sidebar control panel: the sync remote, schedule, security gate, live
 * health, and the most recent sessions — everything the command palette
 * exposes piecemeal, in one place that stays open while you work.
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'opencodeSessionHub.dashboard';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: SyncController
  ) {
    controller.onDidChangeState(() => this.postState());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: Inbound) => this.handleMessage(message));
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private async handleMessage(message: Inbound): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.controller.refreshStatus();
          this.postState();
          return;

        case 'push':
          await this.controller.sync('push');
          this.postState();
          return;

        case 'pull':
          await this.controller.sync('pull');
          this.postState();
          return;

        case 'resolve':
          await this.controller.resolveConflicts(message.keep);
          this.postState();
          return;

        case 'saveConnection':
          await this.controller.updateSetting('syncRemoteUrl', message.remoteUrl.trim());
          await this.controller.updateSetting('syncBranch', message.branch.trim() || 'main');
          this.postState();
          return;

        case 'saveSchedule':
          await this.controller.updateSetting('debounceSeconds', Math.max(1, Math.floor(message.debounceSeconds) || 20));
          await this.controller.updateSetting('autoPullOnStartup', message.autoPullOnStartup);
          await this.controller.updateSetting('autoSyncOnFocusLost', message.autoSyncOnFocusLost);
          this.postState();
          return;

        case 'saveSecurity':
          // Order matters: dropping the acknowledgement must never race with
          // enabling secrets in a way that leaves a moment where both read true.
          if (!message.privateRepoAcknowledged) {
            await this.controller.updateSetting('privateRepoAcknowledged', false);
            await this.controller.updateSetting('includeSecrets', false);
          } else {
            await this.controller.updateSetting('includeSecrets', message.includeSecrets);
            await this.controller.updateSetting('privateRepoAcknowledged', message.privateRepoAcknowledged);
          }
          await this.controller.updateSetting('includeSessions', message.includeSessions);
          await this.controller.updateSetting('redactSecrets', message.redactSecrets);
          this.postState();
          return;

        case 'previewSession':
          this.previewById(message.id);
          return;

        case 'resumeSession':
          this.resumeById(message.id);
          return;

        case 'openFullList':
          await vscode.commands.executeCommand('opencodeSessionHub.listAllSessions');
          return;

        case 'saveFavorite':
          this.controller.addFavorite(message.label, message.sessionId);
          this.postState();
          return;

        case 'removeFavorite':
          this.controller.removeFavorite(message.id);
          this.postState();
          return;

        case 'previewFavorite':
          this.previewById(message.sessionId);
          return;

        case 'resumeFavorite':
          this.resumeById(message.sessionId);
          return;
      }
    } catch (err) {
      const text = err instanceof SyncError ? err.message : String(err);
      vscode.window.showErrorMessage(`OpenCode Session Hub: ${text}`);
      this.postState();
    }
  }

  private findSession(id: string): SessionRecord | undefined {
    return this.controller.listSessions().sessions.find((s) => s.id === id);
  }

  private previewById(sessionId: string): void {
    const record = this.findSession(sessionId);
    if (!record) {
      vscode.window.showWarningMessage(
        `No session with id "${sessionId}" found on this machine yet — try "Pull Now" first.`
      );
      return;
    }
    showSessionPreview(this.controller.getLocations(), record);
  }

  /**
   * A favorite only remembers a session id and a label — it has no directory
   * of its own. Resuming still needs the same cross-OS resolution the full
   * "List All Sessions" flow does, applied to whatever session currently
   * carries that id on this machine.
   */
  private resumeById(sessionId: string): void {
    const record = this.findSession(sessionId);
    if (!record) {
      vscode.window.showWarningMessage(
        `No session with id "${sessionId}" found on this machine yet — try "Pull Now" first.`
      );
      return;
    }

    const directory = resolveLocalDirectory(record.directory, {
      mappings: this.controller.getMappings(),
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      searchRoots: vscode.workspace.getConfiguration('opencodeSessionHub').get<string[]>('projectSearchRoots', []),
    });

    if (!directory) {
      vscode.window.showWarningMessage(
        `"${record.directory || 'unknown'}" does not exist on this machine — use "OpenCode: List All Sessions" to pick a folder for it.`
      );
      return;
    }

    const terminal = vscode.window.createTerminal({ name: `OpenCode: ${record.title}`, cwd: directory });
    terminal.show();
    terminal.sendText(`opencode --session ${record.id}`);
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    const { sessions, warnings } = this.controller.listSessions();
    this.view.webview.postMessage({
      type: 'state',
      state: this.controller.getState(),
      settings: this.controller.getSettings(),
      schedule: {
        debounceSeconds: vscode.workspace.getConfiguration('opencodeSessionHub').get<number>('debounceSeconds', 20),
        autoPullOnStartup: vscode.workspace.getConfiguration('opencodeSessionHub').get<boolean>('autoPullOnStartup', true),
        autoSyncOnFocusLost: vscode.workspace
          .getConfiguration('opencodeSessionHub')
          .get<boolean>('autoSyncOnFocusLost', true),
      },
      sessions: sessions.slice(0, 8).map((s) => ({
        id: s.id,
        title: s.title,
        directory: s.directory,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
      })),
      sessionCount: sessions.length,
      favorites: this.controller.listFavorites(),
      warnings,
    });
  }

  refresh(): void {
    this.postState();
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 12px 16px;
  }
  h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75;
       margin: 1.1rem 0 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.25rem; }
  h2:first-of-type { margin-top: 0.75rem; }
  label { display: block; font-size: 0.8rem; margin: 0.5rem 0 0.15rem; }
  input[type="text"], input[type="number"] {
    width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 6px; border-radius: 2px; font-family: var(--vscode-editor-font-family);
  }
  .checkbox-row { display: flex; align-items: center; gap: 6px; margin: 0.35rem 0; }
  .checkbox-row label { margin: 0; font-size: 0.8rem; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 0.8rem;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 0.5rem; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; }
  .badge-idle { background: var(--vscode-charts-green); color: #000; }
  .badge-syncing { background: var(--vscode-charts-blue); color: #000; }
  .badge-error { background: var(--vscode-errorForeground); color: #fff; }
  .badge-conflict { background: var(--vscode-charts-orange); color: #000; }
  .badge-unconfigured { background: var(--vscode-descriptionForeground); color: #fff; }
  .health-line { font-size: 0.8rem; margin: 0.35rem 0; opacity: 0.9; }
  .warning-banner {
    background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder);
    padding: 6px 8px; border-radius: 3px; font-size: 0.78rem; margin: 0.4rem 0;
  }
  ul.sessions { list-style: none; margin: 0.4rem 0 0; padding: 0; }
  ul.sessions li {
    border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 6px 8px; margin-bottom: 6px;
  }
  ul.sessions .title { font-weight: 600; font-size: 0.82rem; }
  ul.sessions .meta { font-size: 0.72rem; opacity: 0.7; margin: 2px 0 6px; word-break: break-all; }
  .empty { font-size: 0.8rem; opacity: 0.7; font-style: italic; }
</style>
</head>
<body>
  <h2>Health</h2>
  <div id="health"></div>
  <div class="row">
    <button id="btn-push">Push Now</button>
    <button id="btn-pull">Pull Now</button>
    <button id="btn-refresh" class="secondary">Refresh</button>
  </div>
  <div id="conflict-row" class="row" style="display:none">
    <button id="btn-keep-local">Keep Local</button>
    <button id="btn-keep-remote">Keep Remote</button>
  </div>

  <h2>Connection</h2>
  <label for="remoteUrl">Sync repository URL (private)</label>
  <input id="remoteUrl" type="text" placeholder="git@github.com:you/my-opencode-config.git" />
  <label for="branch">Branch</label>
  <input id="branch" type="text" placeholder="main" />
  <div class="row"><button id="btn-save-connection">Save Connection</button></div>

  <h2>Schedule</h2>
  <label for="debounceSeconds">Debounce before auto-push (seconds)</label>
  <input id="debounceSeconds" type="number" min="1" />
  <div class="checkbox-row"><input type="checkbox" id="autoPullOnStartup" /><label for="autoPullOnStartup">Pull on startup</label></div>
  <div class="checkbox-row"><input type="checkbox" id="autoSyncOnFocusLost" /><label for="autoSyncOnFocusLost">Push when window loses focus</label></div>
  <div class="row"><button id="btn-save-schedule">Save Schedule</button></div>

  <h2>Security</h2>
  <div class="checkbox-row"><input type="checkbox" id="includeSessions" /><label for="includeSessions">Sync session history</label></div>
  <div class="checkbox-row"><input type="checkbox" id="includeSecrets" /><label for="includeSecrets">Allow secret-class data</label></div>
  <div class="checkbox-row"><input type="checkbox" id="privateRepoAcknowledged" /><label for="privateRepoAcknowledged">I confirmed the remote repo is PRIVATE</label></div>
  <div class="checkbox-row"><input type="checkbox" id="redactSecrets" /><label for="redactSecrets">Redact credential-shaped strings</label></div>
  <div id="security-warning" class="warning-banner" style="display:none">
    Session history will NOT sync until both boxes above are checked.
  </div>
  <div class="row"><button id="btn-save-security">Save Security</button></div>

  <h2>Sessions (<span id="session-count">0</span> on this machine)</h2>
  <div id="sessions"></div>
  <div class="row"><button id="btn-open-list" class="secondary">Browse All Sessions…</button></div>

  <h2>Favorite Sessions</h2>
  <div id="favorites"></div>
  <label for="favLabel">Comentario</label>
  <input id="favLabel" type="text" placeholder="Sessao de Desenvolvimento de HTML Hello World" />
  <label for="favSessionId">Session Id</label>
  <input id="favSessionId" type="text" placeholder="ses_f4a55ea3effeDnzTiAaKbI0X92" />
  <div class="row">
    <button id="btn-save-favorite">Salvar</button>
    <button id="btn-new-favorite" class="secondary">Incluir novo item</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const badgeLabel = { idle: 'Synced', syncing: 'Syncing…', error: 'Error', conflict: 'Conflict', unconfigured: 'Not configured' };

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render(msg) {
    const { state, settings, schedule, sessions, sessionCount, favorites, warnings } = msg;

    $('health').innerHTML =
      '<span class="badge badge-' + state.status + '">' + badgeLabel[state.status] + '</span>' +
      (state.repoStatus ? '<div class="health-line">Branch ' + escapeHtml(state.repoStatus.branch) +
        ' · ' + state.repoStatus.ahead + ' ahead · ' + state.repoStatus.behind + ' behind' +
        (state.repoStatus.dirty ? ' · local changes pending' : '') + '</div>' : '') +
      (state.lastSyncAt ? '<div class="health-line">Last sync: ' + new Date(state.lastSyncAt).toLocaleString() + '</div>' : '') +
      (state.lastError ? '<div class="health-line" style="color:var(--vscode-errorForeground)">' + escapeHtml(state.lastError) + '</div>' : '') +
      (state.lastOutcome && state.lastOutcome.messages.length
        ? '<div class="health-line">' + state.lastOutcome.messages.map(escapeHtml).join('<br/>') + '</div>' : '') +
      (warnings || []).map((w) => '<div class="health-line" style="color:var(--vscode-errorForeground)">' + escapeHtml(w) + '</div>').join('');

    $('conflict-row').style.display = state.status === 'conflict' ? 'flex' : 'none';

    $('remoteUrl').value = settings.remoteUrl || '';
    $('branch').value = settings.branch || 'main';
    $('debounceSeconds').value = schedule.debounceSeconds;
    $('autoPullOnStartup').checked = schedule.autoPullOnStartup;
    $('autoSyncOnFocusLost').checked = schedule.autoSyncOnFocusLost;
    $('includeSessions').checked = settings.includeSessions;
    $('includeSecrets').checked = settings.includeSecrets;
    $('privateRepoAcknowledged').checked = settings.privateRepoAcknowledged;
    $('redactSecrets').checked = settings.redactSecrets;
    $('security-warning').style.display =
      settings.includeSessions && !(settings.includeSecrets && settings.privateRepoAcknowledged) ? 'block' : 'none';

    $('session-count').textContent = sessionCount;
    $('sessions').innerHTML = sessions.length
      ? '<ul class="sessions">' + sessions.map((s) =>
          '<li><div class="title">' + escapeHtml(s.title) + '</div>' +
          '<div class="meta">' + escapeHtml(s.directory || 'unknown directory') + ' · ' +
          (s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '') + ' · ' + s.messageCount + ' messages</div>' +
          '<div class="row">' +
          '<button class="secondary" data-action="preview" data-id="' + escapeHtml(s.id) + '">Preview</button>' +
          '<button class="secondary" data-action="resume" data-id="' + escapeHtml(s.id) + '">Resume</button>' +
          '</div></li>').join('') + '</ul>'
      : '<p class="empty">No sessions found yet.</p>';

    document.querySelectorAll('[data-action="preview"], [data-action="resume"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        vscode.postMessage({ type: action === 'preview' ? 'previewSession' : 'resumeSession', id });
      });
    });

    $('favorites').innerHTML = (favorites || []).length
      ? '<ul class="sessions">' + favorites.map((f) =>
          '<li><div class="title">' + escapeHtml(f.label) + '</div>' +
          '<div class="meta">' + escapeHtml(f.sessionId) + '</div>' +
          '<div class="row">' +
          '<button class="secondary" data-fav-action="preview" data-session-id="' + escapeHtml(f.sessionId) + '">Preview</button>' +
          '<button class="secondary" data-fav-action="resume" data-session-id="' + escapeHtml(f.sessionId) + '">Resume</button>' +
          '<button class="secondary" data-fav-action="remove" data-id="' + escapeHtml(f.id) + '">Remover</button>' +
          '</div></li>').join('') + '</ul>'
      : '<p class="empty">Nenhuma sessao favoritada ainda.</p>';

    document.querySelectorAll('[data-fav-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-fav-action');
        if (action === 'remove') {
          vscode.postMessage({ type: 'removeFavorite', id: btn.getAttribute('data-id') });
          return;
        }
        const sessionId = btn.getAttribute('data-session-id');
        vscode.postMessage({ type: action === 'preview' ? 'previewFavorite' : 'resumeFavorite', sessionId });
      });
    });
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') render(event.data);
  });

  $('btn-push').addEventListener('click', () => vscode.postMessage({ type: 'push' }));
  $('btn-pull').addEventListener('click', () => vscode.postMessage({ type: 'pull' }));
  $('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('btn-keep-local').addEventListener('click', () => vscode.postMessage({ type: 'resolve', keep: 'local' }));
  $('btn-keep-remote').addEventListener('click', () => vscode.postMessage({ type: 'resolve', keep: 'remote' }));
  $('btn-open-list').addEventListener('click', () => vscode.postMessage({ type: 'openFullList' }));

  $('btn-save-connection').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveConnection', remoteUrl: $('remoteUrl').value, branch: $('branch').value });
  });
  $('btn-save-schedule').addEventListener('click', () => {
    vscode.postMessage({
      type: 'saveSchedule',
      debounceSeconds: Number($('debounceSeconds').value) || 20,
      autoPullOnStartup: $('autoPullOnStartup').checked,
      autoSyncOnFocusLost: $('autoSyncOnFocusLost').checked,
    });
  });
  $('btn-save-security').addEventListener('click', () => {
    vscode.postMessage({
      type: 'saveSecurity',
      includeSecrets: $('includeSecrets').checked,
      privateRepoAcknowledged: $('privateRepoAcknowledged').checked,
      includeSessions: $('includeSessions').checked,
      redactSecrets: $('redactSecrets').checked,
    });
  });

  $('btn-save-favorite').addEventListener('click', () => {
    const sessionId = $('favSessionId').value.trim();
    if (!sessionId) {
      return;
    }
    vscode.postMessage({ type: 'saveFavorite', label: $('favLabel').value, sessionId });
    $('favLabel').value = '';
    $('favSessionId').value = '';
  });
  $('btn-new-favorite').addEventListener('click', () => {
    $('favLabel').value = '';
    $('favSessionId').value = '';
    $('favLabel').focus();
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
