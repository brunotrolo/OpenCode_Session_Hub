import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveLocalDirectory } from './pathMapper';
import { showSessionPreview } from './previewPanel';
import { loadMessages, SessionRecord } from './sessionScanner';
import { SyncController } from './syncController';

type Inbound =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'deleteSelected'; ids: string[] }
  | { type: 'deleteChildren'; parentId: string }  | { type: 'previewSession'; id: string }
  | { type: 'resumeSession'; id: string }
  | { type: 'exportSelected'; ids: string[] };

async function confirmBulkDelete(question: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    question +
      ' This cannot be undone here, and will not remove them from the sync repository or other machines if they were already synced.',
    { modal: true },
    'Delete'
  );
  return choice === 'Delete';
}

/**
 * Full-page session manager: every session on this machine with a checkbox,
 * a text filter, and bulk delete. Built for the "I have 90 sessions and need
 * to remove 60" case, where the one-by-one dashboard flow does not scale.
 *
 * Deletion is local-only with tombstones, exactly like the single-session
 * delete: the sync repo and other machines are intentionally untouched.
 */
export function showSessionManager(controller: SyncController): void {
  const panel = vscode.window.createWebviewPanel(
    'opencodeSessionManager',
    'OpenCode Sessions',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const view = new SessionManagerView(controller, panel);
  view.postSessions();
}

class SessionManagerView {
  private records = new Map<string, SessionRecord>();
  private disposed = false;

  constructor(
    private readonly controller: SyncController,
    private readonly panel: vscode.WebviewPanel
  ) {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.renderHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message: Inbound) => this.handleMessage(message));
    panel.onDidDispose(() => {
      this.disposed = true;
    });
  }

  postSessions(): void {
    if (this.disposed) {
      return;
    }
    const { sessions } = this.controller.listSessions();
    this.records = new Map(sessions.map((s) => [s.id, s]));
    // Cheap mirror check per session (one stat each, no database reads):
    // an export file means this session reached the sync repo.
    const exportDir = path.join(this.controller.getSettings().repoDir, 'data', 'favorite-sessions');
    void this.panel.webview.postMessage({
      type: 'state',
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        directory: s.directory,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        messageCount: s.messageCount,
        synced: fs.existsSync(path.join(exportDir, `${s.id}.db`)),
        ...(s.parentId ? { parentId: s.parentId } : {}),
      })),
    });
  }

  private async handleMessage(message: Inbound): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          this.postSessions();
          return;
        case 'deleteSelected':
          await this.deleteSelected(message.ids ?? []);
          return;
        case 'deleteChildren':
          await this.deleteChildrenByParent(message.parentId ?? '');
          return;
        case 'previewSession':
          this.previewById(message.id);
          return;
        case 'resumeSession':
          this.resumeById(message.id);
          return;
        case 'exportSelected':
          await this.exportSelected(message.ids ?? []);
          return;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`OpenCode Session Hub: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async deleteSelected(ids: string[]): Promise<void> {
    const targets = ids
      .map((id) => this.records.get(id))
      .filter((r): r is SessionRecord => r !== undefined);
    if (targets.length === 0) {
      return;
    }
    const totalMessages = targets.reduce((n, r) => n + r.messageCount, 0);
    const confirmed = await confirmBulkDelete(
      `Delete ${targets.length} session(s) (${totalMessages} messages) from this machine?`
    );
    if (!confirmed) {
      return;
    }
    await this.deleteRecords(targets);
  }

  /**
   * Deletes every child of one parent session and keeps the parent itself.
   * Matching is by the recorded parentId, so it works even when the parent
   * row is already gone and the children are orphaned.
   */
  private async deleteChildrenByParent(parentIdRaw: string): Promise<void> {
    const parentId = parentIdRaw.trim();
    if (!parentId) {
      return;
    }
    const targets = [...this.records.values()].filter((r) => r.parentId === parentId);
    if (targets.length === 0) {
      vscode.window.showWarningMessage(`No child sessions of "${parentId}" found on this machine.`);
      return;
    }
    const totalMessages = targets.reduce((n, r) => n + r.messageCount, 0);
    const confirmed = await confirmBulkDelete(
      `Delete ${targets.length} child session(s) of "${parentId}" (${totalMessages} messages) ` +
        `from this machine, keeping the parent session itself?`
    );
    if (!confirmed) {
      return;
    }
    await this.deleteRecords(targets);
  }

  private async deleteRecords(targets: SessionRecord[]): Promise<void> {

    const failures: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'OpenCode: deleting sessions' },
      async (progress) => {
        let done = 0;
        for (const record of targets) {
          try {
            await this.controller.deleteSession(record);
          } catch (err) {
            failures.push(`${record.title}: ${err instanceof Error ? err.message : String(err)}`);
          }
          done += 1;
          // progress is always present in real VS Code; the test stub
          // invokes the task without one.
          progress?.report({ message: `${done}/${targets.length}`, increment: 100 / targets.length });
        }
      }
    );

    this.postSessions();
    if (failures.length > 0) {
      vscode.window.showWarningMessage(
        `Deleted ${targets.length - failures.length} of ${targets.length} sessions. Failures: ${failures.join(' | ')}`
      );
    } else {
      vscode.window.showInformationMessage(`Deleted ${targets.length} session(s).`);
    }
  }

  private previewById(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) {
      vscode.window.showWarningMessage(`No session with id "${sessionId}" found on this machine yet.`);
      return;
    }
    showSessionPreview(this.controller.getLocations(), record);
  }

  private resumeById(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) {
      vscode.window.showWarningMessage(`No session with id "${sessionId}" found on this machine yet.`);
      return;
    }
    const directory = resolveLocalDirectory(record.directory, {
      mappings: this.controller.getMappings(),
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      searchRoots: vscode.workspace.getConfiguration('opencodeSessionHub').get<string[]>('projectSearchRoots', []),
    });
    if (!directory) {
      vscode.window.showWarningMessage(
        `"${record.directory || 'unknown'}" does not exist on this machine — pick a folder for it first.`
      );
      return;
    }
    const terminal = vscode.window.createTerminal({ name: `OpenCode: ${record.title}`, cwd: directory });
    terminal.show();
    terminal.sendText(`opencode --session ${record.id}`);
  }

  /**
   * Writes one Markdown file per selected session into a chosen folder:
   * title, metadata, then every message under a role heading. A cheap
   * safety net before a bulk delete.
   */
  private async exportSelected(ids: string[]): Promise<void> {
    const targets = ids
      .map((id) => this.records.get(id))
      .filter((r): r is SessionRecord => r !== undefined);
    if (targets.length === 0) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: `Export ${targets.length} session(s) as Markdown here`,
    });
    const dir = picked?.[0]?.fsPath;
    if (!dir) {
      return;
    }
    const locations = this.controller.getLocations();
    let written = 0;
    for (const record of targets) {
      try {
        const messages = loadMessages(locations, record);
        const safeTitle = record.title.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'session';
        const filePath = path.join(dir, `${safeTitle} - ${record.id}.md`);
        fs.writeFileSync(filePath, renderSessionMarkdown(record, messages));
        written += 1;
      } catch (err) {
        vscode.window.showWarningMessage(
          `Could not export "${record.title}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    vscode.window.showInformationMessage(`Exported ${written} of ${targets.length} session(s) to ${dir}.`);
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
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); padding: 12px 16px 24px; margin: 0 auto; max-width: 900px;
  }
  h1 { font-size: 15px; margin: 4px 0 2px; }
  .sub { font-size: 12px; opacity: 0.8; margin-bottom: 12px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  input[type="text"] {
    flex: 1; min-width: 200px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    padding: 5px 10px; border-radius: 2px; font-family: var(--vscode-font-family); font-size: 12px;
  }
  select, input[type="number"] {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 5px 8px; border-radius: 2px; font-family: var(--vscode-font-family); font-size: 12px;
    max-width: 220px;
  }
  input[type="number"] { width: 70px; }
  label.days { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  details.cleanup { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px 12px 12px; margin-bottom: 12px; }
  details.cleanup > summary { cursor: pointer; font-size: 12px; font-weight: 600; padding: 8px 0 2px; }
  .cleanup-row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; margin-top: 8px; }
  .cleanup-row label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; opacity: 0.9; }
  h3.group { font-size: 11px; font-weight: 600; opacity: 0.8; margin: 14px 0 8px; word-break: break-all; }
  h3.group:first-of-type { margin-top: 0; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 12px; border-radius: 2px; cursor: pointer; font-size: 12px;
    font-family: var(--vscode-font-family);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.mini { padding: 2px 8px; font-size: 11px; }
  .danger { background: var(--vscode-errorForeground); color: #fff; }
  label.select-all { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
  ul.sessions { list-style: none; margin: 0; padding: 0; }
  ul.sessions li {
    display: flex; gap: 10px; align-items: flex-start;
    border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px;
  }
  ul.sessions li input[type="checkbox"] { margin-top: 3px; }
  .info { flex: 1; min-width: 0; }
  .title { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 7px; }
  .sync-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .sync-dot.synced { background: var(--vscode-charts-green); }
  .sync-dot.pending { background: var(--vscode-descriptionForeground); }
  .fork-tag {
    font-size: 10px; font-weight: 600; opacity: 0.75; border: 1px solid var(--vscode-panel-border);
    border-radius: 8px; padding: 0 6px; flex: none;
  }
  .dir { font-size: 11px; opacity: 0.85; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .line { font-size: 11px; opacity: 0.75; margin-top: 2px; }
  .sid { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.75; margin-top: 2px; word-break: break-all; }
  .empty { font-size: 12px; opacity: 0.7; font-style: italic; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
</style>
</head>
<body>
  <h1>OpenCode Sessions</h1>
  <div class="sub" id="count"></div>
  <div class="toolbar">
    <input id="filter" type="text" placeholder="Filter by title, folder or session ID…" aria-label="Filter sessions" />
    <select id="project-filter" aria-label="Filter by project"></select>
    <label class="days">Older than <input id="older-than" type="number" min="0" placeholder="days" aria-label="Older than this many days" /> days</label>
  </div>
  <div class="toolbar">
    <label class="select-all"><input type="checkbox" id="select-all" /> Select all visible</label>
    <button id="btn-refresh" class="secondary">Refresh</button>
    <button id="btn-export" class="secondary" disabled>Export selected</button>
    <button id="btn-delete" class="danger" disabled>Delete selected (0)</button>
  </div>
  <details class="cleanup">
    <summary>Automatic cleanup</summary>
    <div class="sub">Selects sessions older than X days with at most Y messages — a dry run first, nothing is deleted until you press Delete.</div>
    <div class="cleanup-row">
      <label>Older than (days)<input id="cleanup-days" type="number" min="1" placeholder="e.g. 90" /></label>
      <label>At most (messages)<input id="cleanup-max" type="number" min="0" placeholder="e.g. 10" /></label>
      <button id="btn-cleanup-find" class="secondary">Select matching</button>
    </div>
    <div class="sub" id="cleanup-result"></div>
    <div class="cleanup-row">
      <label>Parent session ID<input id="children-parent-id" type="text" placeholder="ses_…" /></label>
      <button id="btn-delete-children" class="danger">Delete children (keep parent)</button>
    </div>
  </details>
  <div id="sessions"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let all = [];
  const selected = new Set();

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function projects() {
    const seen = [];
    all.forEach((s) => {
      const dir = s.directory || 'unknown directory';
      if (!seen.includes(dir)) seen.push(dir);
    });
    return seen.sort();
  }

  function syncProjectOptions() {
    const sel = $('project-filter');
    const current = sel.value || 'all';
    sel.innerHTML = '<option value="all">All projects (' + all.length + ')</option>' +
      projects().map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>').join('');
    sel.value = [...sel.options].some((o) => o.value === current) ? current : 'all';
  }

  function visible() {
    const q = $('filter').value.trim().toLowerCase();
    const proj = $('project-filter').value || 'all';
    const days = Number($('older-than').value);
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
    return all.filter((s) => {
      if (proj !== 'all' && (s.directory || 'unknown directory') !== proj) return false;
      if (cutoff > 0 && (s.updatedAt || 0) >= cutoff) return false;
      if (!q) return true;
      return s.title.toLowerCase().includes(q) ||
        (s.directory || '').toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q);
    });
  }

  function rowHtml(s) {
    const dir = s.directory || 'unknown directory';
    const line = (s.updatedAt ? new Date(s.updatedAt).toLocaleString() : 'no date') +
      ' · ' + s.messageCount + ' messages' +
      (s.createdAt ? ' · started ' + new Date(s.createdAt).toLocaleDateString() : '');
    return '<li><input type="checkbox" data-check="' + escapeHtml(s.id) + '"' +
      (selected.has(s.id) ? ' checked' : '') + ' aria-label="Select ' + escapeHtml(s.title) + '" />' +
      '<div class="info"><div class="title"><span class="sync-dot ' + (s.synced ? 'synced' : 'pending') + '"' +
      ' title="' + (s.synced ? 'Synced to the remote repository' : 'Not synced yet') + '"></span>' +
      escapeHtml(s.title) + '</div>' +
      (s.parentId ? '<div class="line"><span class="fork-tag" title="Forked from session ' + escapeHtml(s.parentId) + '">fork</span></div>' : '') +
      '<div class="dir" title="' + escapeHtml(dir) + '">' + escapeHtml(dir) + '</div>' +
      '<div class="line">' + escapeHtml(line) + '</div>' +
      '<div class="sid" title="' + escapeHtml(s.id) + '">Session ID ' + escapeHtml(s.id) + '</div>' +
      '<div class="mini-row" style="margin-top:6px;display:flex;gap:6px">' +
      '<button class="secondary mini" data-act="preview" data-id="' + escapeHtml(s.id) + '">Preview</button>' +
      '<button class="secondary mini" data-act="resume" data-id="' + escapeHtml(s.id) + '">Resume</button>' +
      '</div></div></li>';
  }

  function render() {
    syncProjectOptions();
    const rows = visible();
    const syncedCount = all.filter((s) => s.synced).length;
    $('count').textContent = all.length + ' session(s) on this machine · ' + syncedCount +
      ' synced · ' + selected.size + ' selected';
    const box = $('select-all');
    box.checked = rows.length > 0 && rows.every((s) => selected.has(s.id));
    const del = $('btn-delete');
    del.disabled = selected.size === 0;
    del.textContent = 'Delete selected (' + selected.size + ')';
    const exp = $('btn-export');
    if (exp) exp.disabled = selected.size === 0;
    if (!rows.length) {
      $('sessions').innerHTML = '<p class="empty">No sessions match.</p>';
    } else if (($('project-filter').value || 'all') === 'all') {
      let html = '';
      let lastDir = null;
      rows.forEach((s) => {
        const dir = s.directory || 'unknown directory';
        if (dir !== lastDir) {
          html += '<h3 class="group">' + escapeHtml(dir) + '</h3><ul class="sessions">';
          lastDir = dir;
        }
        html += rowHtml(s);
      });
      $('sessions').innerHTML = html + '</ul>';
    } else {
      $('sessions').innerHTML = '<ul class="sessions">' + rows.map(rowHtml).join('') + '</ul>';
    }
    document.querySelectorAll('[data-check]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.getAttribute('data-check');
        if (box.checked) selected.add(id); else selected.delete(id);
        render();
      });
    });
    document.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id');
        vscode.postMessage({ type: kind === 'preview' ? 'previewSession' : 'resumeSession', id });
      });
    });
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      all = event.data.sessions || [];
      for (const id of [...selected]) {
        if (!all.some((s) => s.id === id)) selected.delete(id);
      }
      render();
    }
  });

  $('filter').addEventListener('input', render);
  $('project-filter').addEventListener('change', render);
  $('older-than').addEventListener('input', render);
  $('btn-cleanup-find').addEventListener('click', () => {
    const days = Number($('cleanup-days').value);
    const max = $('cleanup-max').value === '' ? Infinity : Number($('cleanup-max').value);
    if (!(days > 0)) {
      $('cleanup-result').textContent = 'Enter how many days back counts as old first.';
      return;
    }
    const cutoff = Date.now() - days * 86400000;
    let matched = 0;
    all.forEach((s) => {
      if ((s.updatedAt || 0) < cutoff && s.messageCount <= max) {
        selected.add(s.id);
        matched += 1;
      }
    });
    $('cleanup-result').textContent = matched + ' session(s) match — review the selection, then Delete or Export.';
    render();
  });
  $('btn-export').addEventListener('click', () => {
    vscode.postMessage({ type: 'exportSelected', ids: [...selected] });
  });
  $('btn-delete-children').addEventListener('click', () => {
    vscode.postMessage({ type: 'deleteChildren', parentId: $('children-parent-id').value });
  });
  $('select-all').addEventListener('change', (e) => {
    const on = e.target.checked;
    visible().forEach((s) => { if (on) selected.add(s.id); else selected.delete(s.id); });
    render();
  });
  $('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('btn-delete').addEventListener('click', () => {
    vscode.postMessage({ type: 'deleteSelected', ids: [...selected] });
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function renderSessionMarkdown(
  record: SessionRecord,
  messages: { role: string; text: string; createdAt: number }[]
): string {
  const lines = [
    `# ${record.title}`,
    '',
    `- Session ID: ${record.id}`,
    `- Directory: ${record.directory || 'unknown'}`,
    `- Updated: ${record.updatedAt ? new Date(record.updatedAt).toLocaleString() : 'unknown'}`,
    `- Messages: ${messages.length}`,
    '',
    '---',
    '',
  ];
  for (const message of messages) {
    lines.push(`## ${message.role}`);
    lines.push('');
    lines.push(message.text);
    lines.push('');
  }
  return lines.join('\n');
}
