/**
 * Patterns for credential-shaped strings that must never leave the machine
 * inside a synced session payload. Each pattern's matched value is replaced
 * with a fixed-width placeholder so redaction doesn't leak the secret's
 * length or position.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]{10,}/g, // Anthropic keys (before the generic sk- rule)
  /sk-[a-zA-Z0-9_-]{10,}/g, // OpenAI-style secret keys
  /ghp_[a-zA-Z0-9]{20,}/g, // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{20,}/g, // GitHub OAuth tokens
  /ghs_[a-zA-Z0-9]{20,}/g, // GitHub App server tokens
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWTs
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  /Bearer\s+[a-zA-Z0-9._-]{10,}/g,
  /\b[a-zA-Z0-9._%+-]+:[^\s/@:]{4,}@(?=[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, // user:pass@host in any URL
  /(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis|amqp):\/\/[^\s'"]*:[^\s'"@]+@[^\s'"]+/gi,
];

/**
 * Credential-shaped `key = value` assignments. Kept separate because the
 * replacement must preserve the key and the quoting around the value, which
 * needs its capture groups addressed explicitly.
 */
const ASSIGNMENT_PATTERN =
  /(['"]?(?:[a-z0-9_-]*(?:api[_-]?key|apikey|secret|password|passwd|token|credential)[a-z0-9_-]*)['"]?\s*[:=]\s*)(['"]?)([^'"\s,}]{6,})(\2)/gi;

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
  let result = input.replace(ASSIGNMENT_PATTERN, (_match, prefix, openQuote, _value, closeQuote) =>
    `${prefix}${openQuote}${PLACEHOLDER}${closeQuote}`
  );

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, PLACEHOLDER);
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
