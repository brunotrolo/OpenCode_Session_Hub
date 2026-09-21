import * as assert from 'assert';
import { describe, it } from 'node:test';
import { extractMcpSecrets, sanitizeMcpSecretsInConfigText } from '../mcpSecretGuard';

describe('mcpSecretGuard', () => {
  it('replaces a bare header secret with an {env:VAR} placeholder', () => {
    const { sanitized, redactedCount } = extractMcpSecrets({
      mcp: { myserver: { headers: { 'X-Api-Key': 'sk-super-secret-value' } } },
    });
    assert.strictEqual(redactedCount, 1);
    assert.strictEqual((sanitized as any).mcp.myserver.headers['X-Api-Key'], '{env:opencode_mcp_MYSERVER_X_API_KEY}');
  });

  it('keeps an Authorization header\'s scheme prefix intact, only templating the token', () => {
    const { sanitized } = extractMcpSecrets({
      mcp: { myserver: { headers: { Authorization: 'Bearer abc123secrettoken' } } },
    });
    assert.strictEqual((sanitized as any).mcp.myserver.headers.Authorization, 'Bearer {env:opencode_mcp_MYSERVER_AUTHORIZATION}');
  });

  it('replaces an oauth clientSecret', () => {
    const { sanitized, redactedCount } = extractMcpSecrets({
      mcp: { myserver: { oauth: { clientId: 'not-a-secret', clientSecret: 'real-secret-value' } } },
    });
    assert.strictEqual(redactedCount, 1);
    assert.strictEqual((sanitized as any).mcp.myserver.oauth.clientSecret, '{env:opencode_mcp_MYSERVER_OAUTH_CLIENT_SECRET}');
    assert.strictEqual((sanitized as any).mcp.myserver.oauth.clientId, 'not-a-secret');
  });

  it('leaves an already-templated value alone instead of double-wrapping it', () => {
    const { sanitized, redactedCount } = extractMcpSecrets({
      mcp: { myserver: { headers: { 'X-Api-Key': '{env:MY_OWN_VAR}' } } },
    });
    assert.strictEqual(redactedCount, 0);
    assert.strictEqual((sanitized as any).mcp.myserver.headers['X-Api-Key'], '{env:MY_OWN_VAR}');
  });

  it('never touches config outside mcp.*, e.g. a provider API key', () => {
    const { sanitized, redactedCount } = extractMcpSecrets({
      provider: { anthropic: { options: { apiKey: 'sk-ant-should-stay-as-is' } } },
    });
    assert.strictEqual(redactedCount, 0);
    assert.strictEqual((sanitized as any).provider.anthropic.options.apiKey, 'sk-ant-should-stay-as-is');
  });

  it('does not mutate the input object', () => {
    const original = { mcp: { s: { headers: { Authorization: 'raw-secret' } } } };
    extractMcpSecrets(original);
    assert.strictEqual(original.mcp.s.headers.Authorization, 'raw-secret');
  });

  describe('sanitizeMcpSecretsInConfigText', () => {
    it('returns the original text unchanged when there is nothing to redact', () => {
      const raw = JSON.stringify({ mcp: { s: { headers: { 'X-Id': '{env:ALREADY_TEMPLATED}' } } } });
      const result = sanitizeMcpSecretsInConfigText(raw);
      assert.ok(result);
      assert.strictEqual(result!.redactedCount, 0);
      assert.strictEqual(result!.content, raw);
    });

    it('produces valid, re-parseable JSON when something was redacted', () => {
      const raw = JSON.stringify({ mcp: { s: { headers: { Authorization: 'super-secret' } } } });
      const result = sanitizeMcpSecretsInConfigText(raw);
      assert.ok(result);
      assert.ok(result!.redactedCount > 0);
      const parsed = JSON.parse(result!.content);
      assert.strictEqual(parsed.mcp.s.headers.Authorization, '{env:opencode_mcp_S_AUTHORIZATION}');
    });

    it('returns null for text that is not plain JSON (e.g. jsonc with comments), so callers fall back safely', () => {
      const jsonc = '// a comment\n{ "mcp": {} }';
      assert.strictEqual(sanitizeMcpSecretsInConfigText(jsonc), null);
    });

    it('returns null for a JSON array or primitive at the top level', () => {
      assert.strictEqual(sanitizeMcpSecretsInConfigText('[1,2,3]'), null);
      assert.strictEqual(sanitizeMcpSecretsInConfigText('"just a string"'), null);
    });
  });
});
