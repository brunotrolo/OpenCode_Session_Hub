import * as path from 'path';

export interface XdgPaths {
  homeDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
}

export interface OpenCodeLocations {
  xdg: XdgPaths;
  /** ~/.config/opencode (or $opencode_config_dir) */
  configRoot: string;
  /** ~/.local/share/opencode */
  dataRoot: string;
  /** ~/.local/state/opencode */
  stateRoot: string;
  /** ~/.local/share/opencode/storage */
  storageRoot: string;
  /** ~/.local/share/opencode/opencode.db */
  databasePath: string;
}

/**
 * OpenCode resolves its directories through XDG on every platform — including
 * Windows, where it uses %USERPROFILE%\.local\share rather than %LOCALAPPDATA%.
 * Mirroring that exactly matters: guessing LOCALAPPDATA makes the extension
 * find zero sessions on a real Windows install.
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    if (env.USERPROFILE) {
      return env.USERPROFILE;
    }
    if (env.HOMEDRIVE && env.HOMEPATH) {
      return path.win32.join(env.HOMEDRIVE, env.HOMEPATH);
    }
  }
  return env.HOME ?? '';
}

export function resolveXdgPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): XdgPaths {
  const homeDir = resolveHomeDir(env, platform);
  if (!homeDir) {
    return { homeDir: '', configDir: '', dataDir: '', stateDir: '' };
  }

  return {
    homeDir,
    configDir: env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config'),
    dataDir: env.XDG_DATA_HOME ?? path.join(homeDir, '.local', 'share'),
    stateDir: env.XDG_STATE_HOME ?? path.join(homeDir, '.local', 'state'),
  };
}

export function resolveOpenCodeLocations(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  dataRootOverride?: string
): OpenCodeLocations {
  const xdg = resolveXdgPaths(env, platform);
  const configRoot = env.opencode_config_dir
    ? path.resolve(expandHome(env.opencode_config_dir, xdg.homeDir))
    : path.join(xdg.configDir, 'opencode');
  const dataRoot = dataRootOverride
    ? path.resolve(expandHome(dataRootOverride, xdg.homeDir))
    : path.join(xdg.dataDir, 'opencode');

  return {
    xdg,
    configRoot,
    dataRoot,
    stateRoot: path.join(xdg.stateDir, 'opencode'),
    storageRoot: path.join(dataRoot, 'storage'),
    databasePath: path.join(dataRoot, 'opencode.db'),
  };
}

export function expandHome(inputPath: string, homeDir: string): string {
  if (!inputPath || !homeDir) {
    return inputPath;
  }
  if (inputPath === '~') {
    return homeDir;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

export type SyncItemType = 'file' | 'dir';

export interface SyncItem {
  localPath: string;
  /** Path inside the sync repository, always POSIX-separated. */
  repoPath: string;
  type: SyncItemType;
  /** Secret items only sync when includeSecrets is enabled AND the repo is acknowledged private. */
  isSecret: boolean;
}

export interface SyncPlanOptions {
  includeSecrets: boolean;
  includeSessions: boolean;
  includeModelFavorites: boolean;
  includeOpencodeSkills: boolean;
  includeAgentsDir: boolean;
}

// 'opencode-session-hub-favorites.json' (see favorites.ts) and
// 'opencode-session-hub-deleted-sessions.json' (see deletedSessions.ts) ride
// along here unconditionally, same as AGENTS.md — both are just session ids
// plus labels/timestamps, not secret data, so they sync regardless of the
// includeSecrets gate. The tombstone file in particular MUST sync: it is
// what stops a session deleted on one machine from being re-seeded by
// another machine that still holds its per-session export.
const CONFIG_FILES = [
  'opencode.json',
  'opencode.jsonc',
  'AGENTS.md',
  'opencode-session-hub-favorites.json',
  'opencode-session-hub-deleted-sessions.json',
];
const CONFIG_DIRS = [
  'agent',
  'agents',
  'command',
  'commands',
  'mode',
  'modes',
  'tool',
  'tools',
  'themes',
  'plugin',
  'plugins',
];
/** Repo-relative path of the mirrored SQLite database — shared with dbMerge.ts so a conflict on it can be recognized by name. */
export const SESSION_DB_REPO_PATH = 'data/opencode.db';

/** Session artifact directories, relative to the OpenCode data root. */
const SESSION_DIRS = [
  path.posix.join('storage', 'session'),
  path.posix.join('storage', 'message'),
  path.posix.join('storage', 'part'),
  path.posix.join('storage', 'session_diff'),
  path.posix.join('storage', 'project'),
];

/**
 * Mirrors the item set opencode-synced syncs, so a repo produced by this
 * extension stays readable by the upstream plugin and vice versa.
 */
export function buildSyncPlan(locations: OpenCodeLocations, options: SyncPlanOptions): SyncItem[] {
  const items: SyncItem[] = [];

  for (const name of CONFIG_FILES) {
    items.push({
      localPath: path.join(locations.configRoot, name),
      repoPath: `config/${name}`,
      type: 'file',
      isSecret: false,
    });
  }

  for (const dirName of CONFIG_DIRS) {
    items.push({
      localPath: path.join(locations.configRoot, dirName),
      repoPath: `config/${dirName}`,
      type: 'dir',
      isSecret: false,
    });
  }

  if (options.includeOpencodeSkills) {
    items.push({
      localPath: path.join(locations.configRoot, 'skills'),
      repoPath: 'config/skills',
      type: 'dir',
      isSecret: false,
    });
  }

  if (options.includeAgentsDir) {
    items.push({
      localPath: path.join(locations.xdg.homeDir, '.agents'),
      repoPath: 'config/.agents',
      type: 'dir',
      isSecret: false,
    });
  }

  if (options.includeModelFavorites) {
    items.push({
      localPath: path.join(locations.stateRoot, 'model.json'),
      repoPath: 'state/model.json',
      type: 'file',
      isSecret: false,
    });
  }

  // Session history is treated as secret: it can contain anything the agent
  // ever printed, so it only syncs to a repo explicitly acknowledged private.
  if (options.includeSecrets && options.includeSessions) {
    items.push({
      localPath: locations.databasePath,
      repoPath: SESSION_DB_REPO_PATH,
      type: 'file',
      isSecret: true,
    });

    for (const relative of SESSION_DIRS) {
      items.push({
        localPath: path.join(locations.dataRoot, ...relative.split('/')),
        repoPath: `data/${relative}`,
        type: 'dir',
        isSecret: true,
      });
    }
  }

  return items;
}
