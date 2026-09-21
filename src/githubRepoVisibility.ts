import { spawn } from 'child_process';

/**
 * Adapted from opencode-synced's ensureRepoPrivate (its repo.ts). Our
 * "I confirmed the remote repo is PRIVATE" checkbox is an honor system — a
 * user can tick it for a repo that's actually public, by mistake, and
 * secrets/session history would then sync there with nothing else catching
 * it. Where the `gh` CLI is installed and authenticated, this verifies the
 * claim against GitHub itself instead of just trusting the checkbox.
 *
 * Deliberately best-effort and narrow: only handles github.com remotes
 * (github.com is virtually always what "GitHub" means here, but this could
 * be extended to GitHub Enterprise hosts later), and any failure to check
 * (gh missing, not authenticated, network down, timeout) reports
 * `checked: false` rather than blocking sync — the existing manual
 * checkbox remains the fallback exactly as it works today. It only ever
 * makes the gate MORE strict (catching a real mistake), never less.
 */
export type RepoVisibilityCheck =
  | { checked: true; isPrivate: boolean }
  | { checked: false; reason: string };

const GH_TIMEOUT_MS = 8_000;

/** Extracts "owner/repo" from an https://github.com/... or git@github.com:... remote URL, or null if it isn't a github.com remote. */
export function parseGitHubRepoIdentifier(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const httpsMatch = trimmed.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  const sshMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  return null;
}

export async function checkGitHubRepoPrivacy(remoteUrl: string): Promise<RepoVisibilityCheck> {
  const identifier = parseGitHubRepoIdentifier(remoteUrl);
  if (!identifier) {
    return { checked: false, reason: 'not a github.com remote' };
  }

  let stdout: string;
  try {
    stdout = await runGh(['repo', 'view', identifier, '--json', 'isPrivate']);
  } catch (err) {
    return { checked: false, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    const parsed = JSON.parse(stdout) as { isPrivate?: unknown };
    if (typeof parsed.isPrivate !== 'boolean') {
      return { checked: false, reason: "gh repo view returned no usable 'isPrivate' field" };
    }
    return { checked: true, isPrivate: parsed.isPrivate };
  } catch {
    return { checked: false, reason: 'could not parse gh repo view output' };
  }
}

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('gh', args);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`gh ${args.join(' ')} timed out after ${GH_TIMEOUT_MS}ms`));
    }, GH_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}
