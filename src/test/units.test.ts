import * as assert from 'assert';
import { describe, it } from 'node:test';
import { renderHandoff } from '../handoff';
import { applyMappings, basenameCrossPlatform, resolveLocalDirectory } from '../pathMapper';
import { sanitizeJsonFile, sanitizeString } from '../secretSanitizer';
import { SessionRecord } from '../sessionScanner';

describe('secret sanitizer', () => {
  it('redacts provider keys and tokens', () => {
    const redacted = sanitizeString(
      'key sk-ant-abc1234567890def, gh ghp_abcdefghijklmnopqrstuvwxyz01, aws AKIAIOSFODNN7EXAMPLE'
    );
    assert.ok(!redacted.includes('sk-ant-abc1234567890def'));
    assert.ok(!redacted.includes('ghp_abcdefghijklmnopqrstuvwxyz01'));
    assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE'));
  });

  it('keeps the key and quoting of a credential assignment intact', () => {
    const redacted = sanitizeString('"api_key": "super-secret-value-123"');
    assert.ok(redacted.startsWith('"api_key": "'));
    assert.ok(redacted.trim().endsWith('"'));
    assert.ok(!redacted.includes('super-secret-value-123'));
    // Regression: the closing group used to be replaced with the whole input.
    assert.ok(!redacted.includes('api_key": "«redacted-secret»"api_key'));
  });

  it('redacts credentials embedded in connection strings', () => {
    const redacted = sanitizeString('postgres://admin:hunter2pass@db.internal:5432/app');
    assert.ok(!redacted.includes('hunter2pass'));
  });

  it('leaves ordinary prose and emails alone', () => {
    const text = 'Email me at: bruno@example.com about the sk- prefix convention.';
    assert.strictEqual(sanitizeString(text), text);
  });

  it('preserves JSON structure while redacting values', () => {
    const output = sanitizeJsonFile(JSON.stringify({ nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz01' }, keep: 42 }));
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.keep, 42);
    assert.ok(!JSON.stringify(parsed).includes('ghp_abcdefghijklmnopqrstuvwxyz01'));
  });

  it('passes through non-JSON text without throwing', () => {
    assert.strictEqual(sanitizeJsonFile('# Handoff\nplain markdown'), '# Handoff\nplain markdown');
  });
});

describe('cross-OS path mapping', () => {
  it('splits Windows paths even when running on POSIX', () => {
    assert.strictEqual(basenameCrossPlatform('C:\\Projetos\\meu-repo'), 'meu-repo');
    assert.strictEqual(basenameCrossPlatform('/home/user/meu-repo/'), 'meu-repo');
  });

  it('rewrites a configured Windows prefix to the local one', () => {
    const mapped = applyMappings('C:\\Projetos\\meu-repo\\src', [
      { from: 'C:\\Projetos', to: '/home/user/projects' },
    ]);
    assert.strictEqual(mapped, '/home/user/projects/meu-repo/src');
  });

  it('matches an open workspace folder by name when the recorded path is foreign', () => {
    const resolved = resolveLocalDirectory('C:\\Projetos\\meu-repo', {
      mappings: [],
      workspaceFolders: ['/home/user/meu-repo'],
      searchRoots: [],
      exists: (candidate) => candidate === '/home/user/meu-repo',
    });
    assert.strictEqual(resolved, '/home/user/meu-repo');
  });

  it('searches configured roots one level deep', () => {
    const resolved = resolveLocalDirectory('/work/space/billing', {
      mappings: [],
      workspaceFolders: [],
      searchRoots: ['/home/user/code'],
      exists: (candidate) => candidate === '/home/user/code/billing',
    });
    assert.strictEqual(resolved, '/home/user/code/billing');
  });

  it('returns null rather than a bogus path when nothing matches', () => {
    const resolved = resolveLocalDirectory('/work/space/unknown', {
      mappings: [],
      workspaceFolders: [],
      searchRoots: [],
      exists: () => false,
    });
    assert.strictEqual(resolved, null);
  });
});

describe('handoff rendering', () => {
  const record: SessionRecord = {
    id: 'ses_1',
    title: 'Billing refactor',
    directory: '/work/billing',
    projectId: 'prj',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    messageCount: 2,
    source: 'storage-json',
  };

  it('includes metadata and redacts secrets from the transcript', () => {
    const markdown = renderHandoff(record, [
      { id: 'm1', role: 'user', text: 'token ghp_abcdefghijklmnopqrstuvwxyz01', createdAt: 1 },
      { id: 'm2', role: 'assistant', text: 'done', createdAt: 2 },
    ]);

    assert.ok(markdown.includes('Billing refactor'));
    assert.ok(markdown.includes('/work/billing'));
    assert.ok(markdown.includes('done'));
    assert.ok(!markdown.includes('ghp_abcdefghijklmnopqrstuvwxyz01'));
  });

  it('skips empty messages', () => {
    const markdown = renderHandoff(record, [{ id: 'm1', role: 'user', text: '   ', createdAt: 1 }]);
    assert.ok(!markdown.includes('### user'));
  });
});
