import * as fs from 'fs';
import * as path from 'path';

/** Builds a fake OpenCode home so tests exercise the real on-disk layouts. */
export interface FakeMachine {
  home: string;
  dataRoot: string;
  configRoot: string;
  stateRoot: string;
  env: NodeJS.ProcessEnv;
}

export function createMachine(root: string, name: string): FakeMachine {
  const home = path.join(root, name);
  const dataRoot = path.join(home, '.local', 'share', 'opencode');
  const configRoot = path.join(home, '.config', 'opencode');
  const stateRoot = path.join(home, '.local', 'state', 'opencode');

  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  return {
    home,
    dataRoot,
    configRoot,
    stateRoot,
    env: { HOME: home, USERPROFILE: home },
  };
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

/** Current layout: storage/session/<projectID>/<sessionID>.json */
export function addStorageSession(
  machine: FakeMachine,
  options: {
    projectId: string;
    sessionId: string;
    title: string;
    directory?: string;
    worktree?: string;
    updated?: number;
    messages?: { id: string; role: string; text: string; created: number }[];
  }
): void {
  const storage = path.join(machine.dataRoot, 'storage');

  writeJson(path.join(storage, 'session', options.projectId, `${options.sessionId}.json`), {
    id: options.sessionId,
    title: options.title,
    ...(options.directory ? { directory: options.directory } : {}),
    time: { created: 1_700_000_000_000, updated: options.updated ?? 1_700_000_100_000 },
  });

  if (options.worktree) {
    writeJson(path.join(storage, 'project', `${options.projectId}.json`), {
      id: options.projectId,
      worktree: options.worktree,
      vcs: 'git',
    });
  }

  for (const message of options.messages ?? []) {
    writeJson(path.join(storage, 'message', options.sessionId, `${message.id}.json`), {
      id: message.id,
      role: message.role,
      time: { created: message.created },
    });
    // Message text lives in parts, keyed by message id — not in the message file.
    writeJson(path.join(storage, 'part', message.id, `prt_${message.id}.json`), {
      id: `prt_${message.id}`,
      type: 'text',
      text: message.text,
    });
  }
}

/** Legacy layout: project/<hash>/storage/session/info/<sessionID>.json */
export function addLegacySession(
  machine: FakeMachine,
  options: {
    projectDir: string;
    sessionId: string;
    title: string;
    directory: string;
    messages?: { id: string; role: string; text: string; created: number }[];
  }
): void {
  const base = path.join(machine.dataRoot, 'project', options.projectDir, 'storage', 'session');

  writeJson(path.join(base, 'info', `${options.sessionId}.json`), {
    id: options.sessionId,
    title: options.title,
    directory: options.directory,
    time: { created: 1_600_000_000_000, updated: 1_600_000_500_000 },
  });

  for (const message of options.messages ?? []) {
    writeJson(path.join(base, 'message', options.sessionId, `${message.id}.json`), {
      id: message.id,
      role: message.role,
      time: { created: message.created },
    });
    writeJson(path.join(base, 'part', options.sessionId, message.id, `prt_${message.id}.json`), {
      type: 'text',
      text: message.text,
    });
  }
}

/** Current SQLite layout, mirroring opencode's real table shapes. */
export function addSqliteSession(
  machine: FakeMachine,
  options: {
    sessionId: string;
    projectId: string;
    title: string;
    directory: string;
    updated: number;
    messages?: { id: string; role: string; text: string; created: number }[];
  }
): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(machine.dataRoot, 'opencode.db'));

  db.exec(`CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT,
             time_created INTEGER, time_updated INTEGER, sandboxes TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
             slug TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT,
             time_created INTEGER, time_updated INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
             time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
             time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`);

  db.prepare('INSERT OR REPLACE INTO project VALUES (?, ?, ?, ?, ?, ?)').run(
    options.projectId,
    options.directory,
    'git',
    1_700_000_000_000,
    options.updated,
    '[]'
  );
  db.prepare('INSERT OR REPLACE INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    options.sessionId,
    options.projectId,
    null,
    'slug',
    options.directory,
    options.title,
    '1.0.0',
    1_700_000_000_000,
    options.updated
  );

  for (const message of options.messages ?? []) {
    db.prepare('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)').run(
      message.id,
      options.sessionId,
      message.created,
      message.created,
      JSON.stringify({ role: message.role })
    );
    db.prepare('INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
      `prt_${message.id}`,
      message.id,
      options.sessionId,
      message.created,
      message.created,
      JSON.stringify({ type: 'text', text: message.text })
    );
  }

  db.close();
}
