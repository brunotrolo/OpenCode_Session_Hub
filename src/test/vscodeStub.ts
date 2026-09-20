export interface StubState {
  commands: Map<string, (...args: unknown[]) => unknown>;
  config: Record<string, unknown>;
  quickPickResponder: (items: unknown[], options: unknown) => unknown;
  inputResponder: (options: unknown) => string | undefined;
  /** Controls what a showWarningMessage(...) confirmation resolves to — e.g. return 'Delete' to confirm. */
  warningResponder: (text: string, ...items: string[]) => string | undefined;
  terminals: { name: string; cwd?: string; sent: string[] }[];
  webviews: { title: string; html: string }[];
  messages: { kind: 'info' | 'warn' | 'error'; text: string }[];
  statusBar: { text: string; tooltip: string; command: string };
  disposed: boolean;
  viewProviders: Map<string, unknown>;
  /** Commands invoked via vscode.commands.executeCommand(...), in order. */
  executedCommands: string[];
}

export function installVscodeStub(): StubState {
  const state: StubState = {
    commands: new Map(),
    config: {},
    quickPickResponder: (items) => (items as unknown[])[0],
    inputResponder: () => undefined,
    warningResponder: () => undefined,
    terminals: [],
    webviews: [],
    messages: [],
    statusBar: { text: '', tooltip: '', command: '' },
    disposed: false,
    executedCommands: [],
    viewProviders: new Map(),
  };

  class EventEmitter<T> {
    private listeners: ((value: T) => void)[] = [];
    event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(value: T) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    dispose() {
      this.listeners = [];
    }
  }

  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Beside: -2 },
    ProgressLocation: { Window: 10, Notification: 15 },
    EventEmitter,
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
    workspace: {
      workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) => (key in state.config ? state.config[key] : fallback),
        update: async (key: string, value: unknown) => {
          state.config[key] = value;
        },
      }),
    },
    window: {
      createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
      createStatusBarItem: () => ({
        get text() {
          return state.statusBar.text;
        },
        set text(v: string) {
          state.statusBar.text = v;
        },
        get tooltip() {
          return state.statusBar.tooltip;
        },
        set tooltip(v: string) {
          state.statusBar.tooltip = v;
        },
        get command() {
          return state.statusBar.command;
        },
        set command(v: string) {
          state.statusBar.command = v;
        },
        show: () => undefined,
        dispose: () => {
          state.disposed = true;
        },
      }),
      createTerminal: (options: { name: string; cwd?: string }) => {
        const terminal = { name: options.name, cwd: options.cwd, sent: [] as string[] };
        state.terminals.push(terminal);
        return { show: () => undefined, sendText: (text: string) => terminal.sent.push(text) };
      },
      createWebviewPanel: (_id: string, title: string) => {
        const panel = { title, html: '' };
        state.webviews.push(panel);
        return {
          webview: {
            get html() {
              return panel.html;
            },
            set html(v: string) {
              panel.html = v;
            },
          },
        };
      },
      showQuickPick: async (items: unknown[], options: unknown) => state.quickPickResponder(items, options),
      showInputBox: async (options: unknown) => state.inputResponder(options),
      showOpenDialog: async () => undefined,
      showInformationMessage: async (text: string) => {
        state.messages.push({ kind: 'info', text });
        return undefined;
      },
      showWarningMessage: async (text: string, ...rest: unknown[]) => {
        state.messages.push({ kind: 'warn', text });
        const items = rest.filter((item): item is string => typeof item === 'string');
        return state.warningResponder(text, ...items);
      },
      showErrorMessage: async (text: string) => {
        state.messages.push({ kind: 'error', text });
        return undefined;
      },
      withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
      onDidChangeWindowState: () => ({ dispose: () => undefined }),
      registerWebviewViewProvider: (viewType: string, provider: unknown) => {
        state.viewProviders.set(viewType, provider);
        return { dispose: () => state.viewProviders.delete(viewType) };
      },
    },
    commands: {
      registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
        state.commands.set(name, handler);
        return { dispose: () => state.commands.delete(name) };
      },
      executeCommand: async (name: string) => {
        state.executedCommands.push(name);
        return undefined;
      },
    },
  };

  // The extension host injects `vscode` at runtime; outside it we have to.
  // The namespace import of 'module' is getter-only, so take the CJS object.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loader = require('module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = loader._load;
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return vscode;
    }
    return original.call(this, request, parent, isMain);
  };

  return state;
}

export function setWorkspaceFolders(folders: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require('vscode') as { workspace: { workspaceFolders: unknown } };
  vscode.workspace.workspaceFolders = folders.map((fsPath) => ({ uri: { fsPath } }));
}
