import * as fs from 'fs';
import * as path from 'path';

export interface DirectoryMapping {
  from: string;
  to: string;
}

export interface ResolveOptions {
  /** Explicit user-configured prefix rewrites, applied first. */
  mappings: DirectoryMapping[];
  /** Folders currently open in the window. */
  workspaceFolders: string[];
  /** Folders to scan one level deep for a matching project name. */
  searchRoots: string[];
  exists?: (candidate: string) => boolean;
}

/**
 * A session records the absolute directory of the machine that created it
 * (`C:\Projetos\repo` at home vs `/home/user/repo` at work). Resuming it
 * elsewhere needs that path translated to something that exists here.
 */
export function resolveLocalDirectory(recordedDirectory: string, options: ResolveOptions): string | null {
  const exists = options.exists ?? defaultExists;
  if (!recordedDirectory) {
    return null;
  }

  const mapped = applyMappings(recordedDirectory, options.mappings);
  if (exists(mapped)) {
    return mapped;
  }
  if (mapped !== recordedDirectory && exists(recordedDirectory)) {
    return recordedDirectory;
  }

  const targetName = basenameCrossPlatform(recordedDirectory);
  if (!targetName) {
    return null;
  }

  for (const folder of options.workspaceFolders) {
    if (path.basename(folder).toLowerCase() === targetName.toLowerCase() && exists(folder)) {
      return folder;
    }
  }

  for (const root of options.searchRoots) {
    const candidate = joinPreservingStyle(root, targetName);
    if (exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function applyMappings(inputPath: string, mappings: DirectoryMapping[]): string {
  for (const mapping of mappings) {
    if (!mapping.from) {
      continue;
    }
    // Windows paths are case-insensitive, so compare folded but rebuild from
    // the original so the untouched remainder keeps its real casing.
    const normalizedInput = inputPath.replace(/\\/g, '/').toLowerCase();
    const normalizedFrom = mapping.from.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (normalizedInput === normalizedFrom || normalizedInput.startsWith(`${normalizedFrom}/`)) {
      const remainder = inputPath.replace(/\\/g, '/').slice(normalizedFrom.length).replace(/^\/+/, '');
      return remainder ? joinPreservingStyle(mapping.to, remainder) : mapping.to;
    }
  }
  return inputPath;
}

/**
 * `path.join` always uses the HOST OS's separator, which silently mangles a
 * `mapping.to` written in the other style — e.g. a Windows machine's own
 * `path.join` would turn a deliberately POSIX destination like
 * `/home/user/projects` (a WSL path, or a Git Bash user's usual notation)
 * into `/home/user/projects\repo\src`. `mapping.to` is a string the user
 * typed for a specific destination convention, not a path meant to be
 * reinterpreted through whatever OS happens to be running this extension —
 * so this joins using the separator `mapping.to` itself already uses.
 */
function joinPreservingStyle(base: string, remainder: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const trimmedBase = base.replace(/[\\/]+$/, '');
  const normalizedRemainder = remainder.split(/[\\/]/).join(sep);
  return `${trimmedBase}${sep}${normalizedRemainder}`;
}

/** `path.basename` on POSIX does not split a Windows path, and vice versa. */
export function basenameCrossPlatform(inputPath: string): string {
  const trimmed = inputPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
