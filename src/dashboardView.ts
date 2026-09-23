import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { resolveLocalDirectory } from './pathMapper';
import { showSessionPreview } from './previewPanel';
import { showSessionManager } from './sessionManagerPanel';
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
  | { type: 'deleteSession'; id: string }
  | { type: 'openFullList' }
  | { type: 'openManager' }
  | { type: 'showDebugInfo' }
  | { type: 'compactDatabase' }
  | { type: 'rebuildMirror' }
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

        case 'deleteSession':
          await this.deleteById(message.id);
          return;

        case 'openFullList':
          await vscode.commands.executeCommand('opencodeSessionHub.listAllSessions');
          return;

        case 'openManager':
          showSessionManager(this.controller);
          return;

        case 'showDebugInfo':
          await vscode.commands.executeCommand('opencodeSessionHub.showDebugInfo');
          return;

        case 'compactDatabase':
          await vscode.commands.executeCommand('opencodeSessionHub.compactDatabase');
          this.postState();
          return;

        case 'rebuildMirror':
          await vscode.commands.executeCommand('opencodeSessionHub.rebuildMirror');
          await this.controller.refreshStatus();
          this.postState();
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

  /**
   * Permanently removes a session's own files from this machine and drops
   * any favorite bookmarking it. Deletion is local-only — see
   * SyncController.deleteSession()'s note on why a sync repo copy or
   * another machine's copy is intentionally left untouched.
   */
  private async deleteById(sessionId: string): Promise<void> {
    const record = this.findSession(sessionId);
    if (!record) {
      vscode.window.showWarningMessage(`No session with id "${sessionId}" found on this machine.`);
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Delete "${record.title}" (${record.messageCount} messages) from this machine? This cannot be undone here, and will not remove it from the sync repository or other machines if it was already synced.`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') {
      return;
    }

    try {
      await this.controller.deleteSession(record);
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      return;
    }
    this.postState();
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
        createdAt: s.createdAt,
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
    padding: 0 12px 20px;
    margin: 0;
  }
  h2 { font-size: 11px; font-weight: 600; margin: 18px 0 8px; }
  h2 .h2-action { float: right; font-weight: 400; }
  label { display: block; font-size: 12px; margin: 8px 0 3px; }
  input[type="text"], input[type="number"] {
    width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 8px; border-radius: 2px; font-family: var(--vscode-editor-font-family); font-size: 12px;
  }
  fieldset { border: none; margin: 0; padding: 0; }
  .checkbox-row { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0; }
  .checkbox-row input { margin-top: 2px; }
  .checkbox-row label { margin: 0; font-size: 12px; }
  .checkbox-row .hint { display: block; font-size: 11px; opacity: 0.7; margin-top: 1px; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 12px; border-radius: 2px; cursor: pointer; font-size: 12px;
    font-family: var(--vscode-font-family);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:disabled:hover { background: var(--vscode-button-background); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.secondary:disabled:hover { background: var(--vscode-button-secondaryBackground); }
  button.mini { padding: 2px 8px; font-size: 11px; }
  button.danger-text {
    background: none; color: var(--vscode-errorForeground); padding: 2px 4px; font-size: 11px;
  }
  button.danger-text:hover { background: none; text-decoration: underline; }
  button.linklike {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--vscode-textLink-foreground); font-size: 11px; font-family: var(--vscode-font-family);
  }
  button.linklike:hover { text-decoration: underline; }
  button.title-link {
    background: none; border: none; padding: 0; cursor: pointer; text-align: left;
    color: var(--vscode-textLink-foreground); font-weight: 600; font-size: 13px;
    font-family: var(--vscode-font-family);
  }
  button.title-link:hover { text-decoration: underline; }
  button.star {
    background: none; border: none; padding: 2px; cursor: pointer; flex: none;
    color: var(--vscode-descriptionForeground); display: inline-flex; align-items: center;
  }
  button.star:hover { color: var(--vscode-foreground); }
  button.star.on { color: var(--vscode-charts-yellow); }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .status-card {
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    padding: 10px 12px; margin-top: 12px;
  }
  .status-line { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot-idle { background: var(--vscode-charts-green); }
  .dot-syncing { background: var(--vscode-charts-blue); }
  .dot-error { background: var(--vscode-errorForeground); }
  .dot-conflict { background: var(--vscode-charts-orange); }
  .dot-unconfigured { background: var(--vscode-descriptionForeground); }
  .sub { font-size: 12px; opacity: 0.85; margin-top: 5px; }
  .outcome-ok { font-size: 12px; margin-top: 5px; color: var(--vscode-charts-green); }
  .error-line { font-size: 12px; margin-top: 6px; color: var(--vscode-errorForeground); }
  .row { display: flex; gap: 6px; margin-top: 10px; }
  details.setup { border-top: 1px solid var(--vscode-panel-border); margin-top: 12px; padding-bottom: 4px; }
  details.setup > summary { cursor: pointer; font-size: 11px; font-weight: 600; padding: 8px 0 2px; }
  .desc { font-size: 12px; opacity: 0.8; margin: 2px 0 8px; }
  .adv-item { margin: 10px 0; }
  .adv-item p { font-size: 12px; opacity: 0.8; margin: 2px 0 6px; }
  ul.sessions { list-style: none; margin: 0; padding: 0; }
  ul.sessions li {
    border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px;
  }
  .session-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .session-top .title-link { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta-dir {
    font-size: 11px; opacity: 0.85; margin-top: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .meta-line { font-size: 11px; opacity: 0.75; margin-top: 3px; }
  .meta-id {
    font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.75;
    margin-top: 3px; word-break: break-all;
  }
  .mini-row { display: flex; gap: 6px; align-items: center; }
  .fav-id { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.7; word-break: break-all; margin: 3px 0 8px; }
  .warning-banner {
    background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder);
    padding: 8px 10px; border-radius: 6px; font-size: 12px; margin: 8px 0;
  }
  .empty { font-size: 12px; opacity: 0.7; font-style: italic; }
</style>
</head>
<body>
  <div class="status-card" aria-live="polite">
    <div id="health"></div>
    <div class="row">
      <button id="btn-push">Push Now</button>
      <button id="btn-pull" class="secondary">Pull Now</button>
      <button id="btn-refresh" class="secondary">Refresh</button>
    </div>
    <div id="conflict-row" class="row" style="display:none">
      <button id="btn-keep-local">Keep Local</button>
      <button id="btn-keep-remote" class="secondary">Keep Remote</button>
    </div>
  </div>

  <h2>Sessions (<span id="session-count">0</span> on this machine)
    <span class="h2-action"><button id="btn-open-manager" class="linklike">Manage…</button>
    · <button id="btn-open-list" class="linklike">Browse all…</button></span>
  </h2>
  <div id="sessions"></div>

  <h2>Favorite Sessions</h2>
  <div id="favorites"></div>
  <details id="fav-manual">
    <summary style="font-size:11px;cursor:pointer;">Add favorite by session ID</summary>
    <p class="desc">Only needed when the session is not listed above. Otherwise just use the star on its row.</p>
    <label for="favLabel">Label</label>
    <input id="favLabel" type="text" placeholder="e.g. Checkout redesign" />
    <label for="favSessionId">Session ID</label>
    <input id="favSessionId" type="text" placeholder="ses_…" />
    <div class="row"><button id="btn-save-favorite">Save Favorite</button></div>
  </details>

  <details class="setup" id="setup-connection">
    <summary>Connection</summary>
    <p class="desc">Where this machine syncs to. Must be a private repository.</p>
    <label for="remoteUrl">Sync repository URL (private)</label>
    <input id="remoteUrl" type="text" placeholder="git@github.com:you/my-opencode-config.git" />
    <label for="branch">Branch</label>
    <input id="branch" type="text" placeholder="main" />
    <div class="row"><button id="btn-save-connection">Save Connection</button></div>
  </details>

  <details class="setup" id="setup-schedule">
    <summary>Schedule</summary>
    <label for="debounceSeconds">Wait before auto-push (seconds)</label>
    <input id="debounceSeconds" type="number" min="1" />
    <div class="checkbox-row"><input type="checkbox" id="autoPullOnStartup" /><label for="autoPullOnStartup">Pull on startup</label></div>
    <div class="checkbox-row"><input type="checkbox" id="autoSyncOnFocusLost" /><label for="autoSyncOnFocusLost">Push when window loses focus</label></div>
    <div class="row"><button id="btn-save-schedule">Save Schedule</button></div>
  </details>

  <details class="setup" id="setup-security">
    <summary>Security</summary>
    <p class="desc">Session history only syncs while both boxes are checked.</p>
    <fieldset>
      <div class="checkbox-row"><input type="checkbox" id="includeSessions" /><label for="includeSessions">Sync session history<span class="hint">Message content leaves this machine.</span></label></div>
      <div class="checkbox-row"><input type="checkbox" id="includeSecrets" /><label for="includeSecrets">Allow secret-class data<span class="hint">Includes session content and credentials.</span></label></div>
      <div class="checkbox-row"><input type="checkbox" id="privateRepoAcknowledged" /><label for="privateRepoAcknowledged">My remote repo is PRIVATE<span class="hint">Confirm this before enabling secrets.</span></label></div>
      <div class="checkbox-row"><input type="checkbox" id="redactSecrets" /><label for="redactSecrets">Redact credentials<span class="hint">Replaces credential-shaped strings before syncing.</span></label></div>
    </fieldset>
    <div id="security-warning" class="warning-banner" style="display:none">
      Session history stays on this machine until both boxes above are checked.
    </div>
    <div class="row"><button id="btn-save-security">Save Security</button></div>
  </details>

  <details class="setup" id="setup-advanced">
    <summary>Advanced</summary>
    <div class="adv-item">
      <button id="btn-debug" class="secondary">Show Debug Info</button>
      <p>Exactly what has been synced, and what was skipped.</p>
    </div>
    <div class="adv-item">
      <button id="btn-compact-db" class="secondary">Compact Database…</button>
      <p>Shrinks the local session database when it is too large to sync. Close OpenCode first.</p>
    </div>
    <div class="adv-item">
      <button id="btn-rebuild-mirror" class="secondary">Rebuild Local Mirror…</button>
      <p>Discards the local sync copy and clones it again from the remote. Your sessions are not touched.</p>
    </div>
  </details>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const statusWord = { idle: 'Synced', syncing: 'Syncing…', error: 'Error', conflict: 'Conflict', unconfigured: 'Not configured' };

  const STAR_OUTLINE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z"/></svg>';
  const STAR_FILLED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z"/></svg>';

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Never clobber what the user is typing: background refreshes must not
  // overwrite a focused field.
  function setValue(id, value) {
    const el = $(id);
    if (el && document.activeElement !== el && el.value !== value) el.value = value;
  }
  function setChecked(id, value) {
    const el = $(id);
    if (el && document.activeElement !== el) el.checked = !!value;
  }

  function render(msg) {
    const { state, settings, schedule, sessions, sessionCount, favorites, warnings } = msg;
    const favBySession = {};
    (favorites || []).forEach((f) => { favBySession[f.sessionId] = f; });

    const busy = state.status === 'syncing';
    const configured = state.status !== 'unconfigured';
    $('btn-push').disabled = busy || !configured;
    $('btn-pull').disabled = busy || !configured;

    let health = '<div class="status-line"><span class="dot dot-' + state.status + '"></span>' +
      statusWord[state.status] + '</div>';
    if (state.repoStatus) {
      health += '<div class="sub">Branch ' + escapeHtml(state.repoStatus.branch) +
        ' · ' + state.repoStatus.ahead + ' ahead · ' + state.repoStatus.behind + ' behind' +
        (state.repoStatus.dirty ? ' · local changes pending' : '') + '</div>';
    }
    if (!configured) {
      health += '<div class="sub">Save a connection below to start syncing.</div>';
    }
    if (busy) {
      health += '<div class="sub">Syncing…</div>';
    }
    if (state.lastSyncAt) {
      health += '<div class="sub">Last sync: ' + new Date(state.lastSyncAt).toLocaleString() + '</div>';
    }
    if (state.lastOutcome && state.lastOutcome.messages.length) {
      health += state.lastOutcome.messages.map((m) =>
        (m.includes('Skipped') || m.includes('NOT synced'))
          ? '<div class="error-line">' + escapeHtml(m) + '</div>'
          : '<div class="outcome-ok">' + escapeHtml(m) + '</div>').join('');
      if (state.lastOutcome.messages.some((m) => m.includes('Skipped opencode.db'))) {
        health += '<div class="row"><button id="btn-compact-inline" class="secondary">' +
          'Close OpenCode, then Compact Database…</button></div>';
      }
    }
    if (state.lastError) {
      health += '<div class="error-line">' + escapeHtml(state.lastError) + '</div>' +
        '<div class="row"><button id="btn-retry" class="secondary">Retry</button></div>';
    }
    health += (warnings || []).map((w) => '<div class="error-line">' + escapeHtml(w) + '</div>').join('');
    $('health').innerHTML = health;
    const retry = $('btn-retry');
    if (retry) {
      retry.addEventListener('click', () => {
        const pendingPush = state.repoStatus && state.repoStatus.ahead > 0;
        vscode.postMessage({ type: pendingPush ? 'push' : 'pull' });
      });
    }
    const compactInline = $('btn-compact-inline');
    if (compactInline) {
      compactInline.addEventListener('click', () => vscode.postMessage({ type: 'compactDatabase' }));
    }

    $('conflict-row').style.display = state.status === 'conflict' ? 'flex' : 'none';

    // Setup sections open themselves only while they block anything.
    $('setup-connection').open = !configured;
    $('setup-security').open = !!(settings.includeSessions &&
      !(settings.includeSecrets && settings.privateRepoAcknowledged));

    setValue('remoteUrl', settings.remoteUrl || '');
    setValue('branch', settings.branch || 'main');
    setValue('debounceSeconds', schedule.debounceSeconds);
    setChecked('autoPullOnStartup', schedule.autoPullOnStartup);
    setChecked('autoSyncOnFocusLost', schedule.autoSyncOnFocusLost);
    setChecked('includeSessions', settings.includeSessions);
    setChecked('includeSecrets', settings.includeSecrets);
    setChecked('privateRepoAcknowledged', settings.privateRepoAcknowledged);
    setChecked('redactSecrets', settings.redactSecrets);
    $('security-warning').style.display =
      settings.includeSessions && !(settings.includeSecrets && settings.privateRepoAcknowledged) ? 'block' : 'none';

    $('session-count').textContent = sessionCount;
    $('sessions').innerHTML = sessions.length
      ? '<ul class="sessions">' + sessions.map((s) => {
          const fav = favBySession[s.id];
          const dir = s.directory || 'unknown directory';
          const line = (s.updatedAt ? new Date(s.updatedAt).toLocaleString() : 'no date') +
            ' · ' + s.messageCount + ' messages' +
            (s.createdAt ? ' · started ' + new Date(s.createdAt).toLocaleDateString() : '');
          return '<li><div class="session-top">' +
            '<button class="star' + (fav ? ' on' : '') + '" data-star="1" data-sid="' + escapeHtml(s.id) + '"' +
            (fav ? ' data-fav-id="' + escapeHtml(fav.id) + '"' : '') +
            ' data-label="' + escapeHtml(s.title) + '"' +
            ' title="' + (fav ? 'Remove from favorites' : 'Add to favorites') + '"' +
            ' aria-pressed="' + (fav ? 'true' : 'false') + '" aria-label="' +
            (fav ? 'Remove from favorites' : 'Add to favorites') + '">' +
            (fav ? STAR_FILLED : STAR_OUTLINE) + '</button>' +
            '<button class="title-link" data-action="resume" data-id="' + escapeHtml(s.id) + '"' +
            ' title="Resume in a terminal">' + escapeHtml(s.title) + '</button></div>' +
            '<div class="meta-dir" title="' + escapeHtml(dir) + '">' + escapeHtml(dir) + '</div>' +
            '<div class="meta-line">' + escapeHtml(line) + '</div>' +
            '<div class="meta-id" title="' + escapeHtml(s.id) + '">Session ID ' + escapeHtml(s.id) + '</div>' +
            '<div class="mini-row" style="margin-top:8px">' +
            '<button class="secondary mini" data-action="preview" data-id="' + escapeHtml(s.id) + '">Preview</button>' +
            '<button class="danger-text" data-action="delete" data-id="' + escapeHtml(s.id) + '">Delete</button>' +
            '</div></li>';
        }).join('') + '</ul>'
      : '<p class="empty">No sessions on this machine yet.</p>';

    const sessionActionMessage = { preview: 'previewSession', resume: 'resumeSession', delete: 'deleteSession' };
    document.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        vscode.postMessage({ type: sessionActionMessage[action], id });
      });
    });
    document.querySelectorAll('[data-star]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const favId = btn.getAttribute('data-fav-id');
        if (favId) {
          vscode.postMessage({ type: 'removeFavorite', id: favId });
        } else {
          vscode.postMessage({
            type: 'saveFavorite',
            label: btn.getAttribute('data-label') || btn.getAttribute('data-sid'),
            sessionId: btn.getAttribute('data-sid'),
          });
        }
      });
    });

    $('favorites').innerHTML = (favorites || []).length
      ? '<ul class="sessions">' + favorites.map((f) =>
          '<li><div class="title-link" style="cursor:default">' + escapeHtml(f.label) + '</div>' +
          '<div class="fav-id">' + escapeHtml(f.sessionId) + '</div>' +
          '<div class="mini-row">' +
          '<button class="secondary mini" data-fav-action="preview" data-session-id="' + escapeHtml(f.sessionId) + '">Preview</button>' +
          '<button class="secondary mini" data-fav-action="resume" data-session-id="' + escapeHtml(f.sessionId) + '">Resume</button>' +
          '<button class="danger-text" data-fav-action="remove" data-id="' + escapeHtml(f.id) + '">Remove</button>' +
          '</div></li>').join('') + '</ul>'
      : '<p class="empty">No favorites yet — use the star on any session above.</p>';

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
  $('btn-debug').addEventListener('click', () => vscode.postMessage({ type: 'showDebugInfo' }));
  $('btn-compact-db').addEventListener('click', () => vscode.postMessage({ type: 'compactDatabase' }));
  $('btn-rebuild-mirror').addEventListener('click', () => vscode.postMessage({ type: 'rebuildMirror' }));
  $('btn-keep-local').addEventListener('click', () => vscode.postMessage({ type: 'resolve', keep: 'local' }));
  $('btn-keep-remote').addEventListener('click', () => vscode.postMessage({ type: 'resolve', keep: 'remote' }));
  $('btn-open-list').addEventListener('click', () => vscode.postMessage({ type: 'openFullList' }));
  $('btn-open-manager').addEventListener('click', () => vscode.postMessage({ type: 'openManager' }));

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
    vscode.postMessage({ type: 'saveFavorite', label: $('favLabel').value.trim() || sessionId, sessionId });
    $('favLabel').value = '';
    $('favSessionId').value = '';
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
