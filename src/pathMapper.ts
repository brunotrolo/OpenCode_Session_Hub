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
    const candidate = path.join(root, targetName);
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
      return remainder ? path.join(mapping.to, remainder) : mapping.to;
    }
  }
  return inputPath;
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
