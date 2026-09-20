import * as vscode from 'vscode';
import { loadSessionMessages, SessionRecord } from './sessionScanner';

/** Read-only webview rendering a session's messages as formatted markdown-ish text. */
export function showSessionPreview(record: SessionRecord) {
  const panel = vscode.window.createWebviewPanel(
    'opencodeSessionPreview',
    `OpenCode: ${record.title}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );

  const messages = loadSessionMessages(record);
  panel.webview.html = renderHtml(record, messages);
}

function renderHtml(record: SessionRecord, messages: ReturnType<typeof loadSessionMessages>): string {
  const body = messages
    .map((msg) => {
      const role = escapeHtml(String(msg.role ?? 'unknown'));
      const text = escapeHtml(extractText(msg));
      return `<section class="msg ${role}"><h3>${role}</h3><pre>${text}</pre></section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 1rem; color: var(--vscode-foreground); }
  h1 { font-size: 1.1rem; }
  .meta { opacity: 0.7; margin-bottom: 1rem; font-size: 0.85rem; }
  .msg { border-left: 3px solid var(--vscode-textLink-foreground); padding-left: 0.75rem; margin-bottom: 1rem; }
  .msg.user { border-color: var(--vscode-charts-blue); }
  .msg.assistant { border-color: var(--vscode-charts-green); }
  pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
  <h1>${escapeHtml(record.title)}</h1>
  <div class="meta">
    ${escapeHtml(record.directory)} · ${new Date(record.updatedAt).toLocaleString()} · ${record.messageCount} messages
  </div>
  ${body || '<p>No messages found for this session.</p>'}
</body>
</html>`;
}

function extractText(msg: Record<string, unknown>): string {
  if (typeof msg.text === 'string') {
    return msg.text;
  }
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(msg, null, 2);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
