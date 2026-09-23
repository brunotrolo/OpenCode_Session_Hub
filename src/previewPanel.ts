import * as vscode from 'vscode';
import { OpenCodeLocations } from './opencodePaths';
import { loadMessages, SessionMessage, SessionRecord } from './sessionScanner';

/** Read-only webview rendering a session's messages. */
export function showSessionPreview(locations: OpenCodeLocations, record: SessionRecord) {
  const panel = vscode.window.createWebviewPanel(
    'opencodeSessionPreview',
    `OpenCode: ${record.title}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );

  panel.webview.html = renderHtml(record, loadMessages(locations, record));
}

export function renderHtml(record: SessionRecord, messages: SessionMessage[]): string {
  const body = messages
    .map((msg) => {
      const role = escapeHtml(msg.role);
      return `<section class="msg ${role}"><h3>${role}</h3><pre>${escapeHtml(msg.text)}</pre></section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<style>
  body { font-family: var(--vscode-font-family); padding: 1rem; color: var(--vscode-foreground); }
  h1 { font-size: 1.1rem; margin-bottom: 0.25rem; }
  .meta { opacity: 0.7; margin-bottom: 1rem; font-size: 0.85rem; }
  .msg { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 0.6rem 0.75rem; margin-bottom: 0.75rem; }
  .msg h3 { font-size: 0.8rem; margin: 0 0 0.35rem; display: flex; align-items: center; gap: 0.4rem; }
  .msg h3::before { content: ""; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--vscode-descriptionForeground); }
  .msg.user h3::before { background: var(--vscode-charts-blue); }
  .msg.assistant h3::before { background: var(--vscode-charts-green); }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
  <h1>${escapeHtml(record.title)}</h1>
  <div class="meta">
    ${escapeHtml(record.directory || 'unknown directory')} ·
    ${record.updatedAt ? new Date(record.updatedAt).toLocaleString() : 'no timestamp'} ·
    ${messages.length} messages · ${escapeHtml(record.source)}
  </div>
  ${body || '<p>No messages stored for this session.</p>'}
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
