/**
 * Adapted from iHildy/opencode-synced's src/sync/mcp-secrets.ts. Their
 * plugin restores these at OpenCode's own config-load time (it runs inside
 * OpenCode); we don't have that hook — we're an external syncer — so this
 * only handles the push side: strip real MCP credentials out of the copy
 * that reaches the sync repo, replacing them with OpenCode's own supported
 * `{env:VAR}` placeholder syntax. The local opencode.json this machine
 * actually uses is never touched.
 *
 * Unlike sanitizeJsonFile's blanket "«redacted-secret»" replacement (which
 * is intentionally lossy and would break the file if ever applied back),
 * this only replaces known MCP credential fields with valid, meaningful
 * placeholders — the file stays fully functional wherever the same
 * environment variable is set.
 */

const ENV_PLACEHOLDER_PATTERN = /\{env:[^}]+\}/i;

export interface McpSecretGuardResult {
  /** The config with any found MCP secrets replaced by {env:VAR} placeholders. */
  sanitized: Record<string, unknown>;
  /** How many individual secret values were replaced. */
  redactedCount: number;
}

/**
 * Parses `raw` as JSON and strips MCP header/oauth secrets from it. Returns
 * `null` if `raw` isn't a plain JSON object (e.g. a `.jsonc` file with
 * comments) — callers should fall back to copying the file unchanged rather
 * than risk corrupting something this can't safely parse.
 */
export function sanitizeMcpSecretsInConfigText(raw: string): { content: string; redactedCount: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }

  const { sanitized, redactedCount } = extractMcpSecrets(parsed as Record<string, unknown>);
  if (redactedCount === 0) {
    return { content: raw, redactedCount: 0 };
  }
  return { content: `${JSON.stringify(sanitized, null, 2)}\n`, redactedCount };
}

export function extractMcpSecrets(config: Record<string, unknown>): McpSecretGuardResult {
  const sanitized = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  let redactedCount = 0;

  const mcp = getPlainObject(sanitized.mcp);
  if (!mcp) {
    return { sanitized, redactedCount };
  }

  for (const [serverName, serverConfigValue] of Object.entries(mcp)) {
    if (serverName === '__proto__') {
      continue; // never touch/traverse this — not a real server entry either way
    }
    const serverConfig = getPlainObject(serverConfigValue);
    if (!serverConfig) {
      continue;
    }

    const headers = getPlainObject(serverConfig.headers);
    if (headers) {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (typeof headerValue !== 'string' || !isSecretString(headerValue)) {
          continue;
        }
        const envVar = buildHeaderEnvVar(serverName, headerName);
        headers[headerName] = buildHeaderPlaceholder(headerValue, envVar, headerName);
        redactedCount += 1;
      }
    }

    const oauth = getPlainObject(serverConfig.oauth);
    if (oauth && typeof oauth.clientSecret === 'string' && isSecretString(oauth.clientSecret)) {
      const envVar = buildEnvVar(serverName, 'OAUTH_CLIENT_SECRET');
      oauth.clientSecret = `{env:${envVar}}`;
      redactedCount += 1;
    }
  }

  return { sanitized, redactedCount };
}

function isSecretString(value: string): boolean {
  return value.length > 0 && !ENV_PLACEHOLDER_PATTERN.test(value);
}

function buildHeaderEnvVar(serverName: string, headerName: string): string {
  if (/^[A-Z0-9_]+$/.test(headerName)) {
    return headerName;
  }
  return buildEnvVar(serverName, headerName);
}

function buildEnvVar(serverName: string, key: string): string {
  return `opencode_mcp_${toEnvToken(serverName, 'SERVER')}_${toEnvToken(key, 'VALUE')}`;
}

function toEnvToken(input: string, fallback: string): string {
  const cleaned = input
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned ? cleaned.toUpperCase() : fallback;
}

function buildHeaderPlaceholder(value: string, envVar: string, headerName: string): string {
  const isAuthHeader = headerName.toLowerCase() === 'authorization' || headerName.toLowerCase() === 'proxy-authorization';
  if (!isAuthHeader) {
    return `{env:${envVar}}`;
  }
  // Keeps a scheme prefix like "Bearer " intact so only the actual token/secret is templated out.
  const schemeMatch = value.match(/^([A-Za-z][A-Za-z0-9+.-]*)\s+/);
  return schemeMatch ? `${schemeMatch[0]}{env:${envVar}}` : `{env:${envVar}}`;
}

function getPlainObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? (value as Record<string, unknown>) : null;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
