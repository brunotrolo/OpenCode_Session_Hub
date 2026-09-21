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

  describe('environment variables on a local MCP server', () => {
    it('templates out a credential-named environment variable', () => {
      // How a `local` MCP server actually carries its token — the most
      // common place a real credential sits in an opencode.json.
      const { sanitized, redactedCount } = extractMcpSecrets({
        mcp: { github: { type: 'local', environment: { GITHUB_TOKEN: 'ghp_realtoken1234567890abc' } } },
      });
      assert.strictEqual(redactedCount, 1);
      assert.strictEqual(
        (sanitized as any).mcp.github.environment.GITHUB_TOKEN,
        '{env:GITHUB_TOKEN}'
      );
    });

    it('leaves non-secret environment variables untouched so the server still runs', () => {
      const { sanitized, redactedCount } = extractMcpSecrets({
        mcp: { srv: { type: 'local', environment: { NODE_ENV: 'production', PORT: '8080' } } },
      });
      assert.strictEqual(redactedCount, 0);
      assert.strictEqual((sanitized as any).mcp.srv.environment.NODE_ENV, 'production');
      assert.strictEqual((sanitized as any).mcp.srv.environment.PORT, '8080');
    });

    it('catches a credential-shaped value even under an innocuous variable name', () => {
      const { sanitized, redactedCount } = extractMcpSecrets({
        mcp: { srv: { type: 'local', environment: { SETTING: 'sk-abcdefghijklmnop12345' } } },
      });
      assert.strictEqual(redactedCount, 1);
      assert.strictEqual((sanitized as any).mcp.srv.environment.SETTING, '{env:SETTING}');
    });

    it('also handles the shorthand `env` key', () => {
      const { redactedCount } = extractMcpSecrets({
        mcp: { srv: { type: 'local', env: { API_KEY: 'realvalue123456' } } },
      });
      assert.strictEqual(redactedCount, 1);
    });

    it('leaves an already-templated environment value alone', () => {
      const { redactedCount } = extractMcpSecrets({
        mcp: { srv: { type: 'local', environment: { GITHUB_TOKEN: '{env:GITHUB_TOKEN}' } } },
      });
      assert.strictEqual(redactedCount, 0);
    });
  });
});
