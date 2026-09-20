/**
 * Patterns for credential-shaped strings that must never leave the machine
 * inside a synced session payload. Each pattern's matched value is replaced
 * with a fixed-width placeholder so redaction doesn't leak the secret's
 * length or position.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{10,}/g, // OpenAI/Anthropic-style secret keys
  /sk-ant-[a-zA-Z0-9_-]{10,}/g, // Anthropic keys explicitly
  /ghp_[a-zA-Z0-9]{20,}/g, // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{20,}/g, // GitHub OAuth tokens
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /Bearer\s+[a-zA-Z0-9._-]{10,}/g,
  /(['"]?(?:api[_-]?key|apikey|secret|password|passwd|token)['"]?\s*[:=]\s*['"])([^'"\s]{6,})(['"])/gi,
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^\s'"]+/gi, // DB connection strings with credentials
  /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s'"]+/gi,
];

const PLACEHOLDER = '«redacted-secret»';

/**
 * Recursively sanitizes a JSON-serializable value, redacting any string
 * that matches a known credential pattern. Structure (keys, array order) is
 * preserved so the sanitized session data is still usable/diffable.
 */
export function sanitizeValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeValue(val);
    }
    return out as unknown as T;
  }
  return value;
}

export function sanitizeString(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, ...groups) => {
      // For the key=value style pattern, keep the surrounding quotes/prefix.
      if (groups.length >= 3 && typeof groups[0] === 'string') {
        return `${groups[0]}${PLACEHOLDER}${groups[groups.length - 1]}`;
      }
      return PLACEHOLDER;
    });
  }
  return result;
}

export function sanitizeJsonFile(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson);
    return JSON.stringify(sanitizeValue(parsed), null, 2);
  } catch {
    // Not valid JSON (e.g. a .md handoff file) — sanitize as plain text.
    return sanitizeString(rawJson);
  }
}
