import * as assert from 'assert';
import { describe, it } from 'node:test';
import { parseGitHubRepoIdentifier } from '../githubRepoVisibility';

describe('parseGitHubRepoIdentifier', () => {
  it('parses an https github.com URL', () => {
    assert.strictEqual(parseGitHubRepoIdentifier('https://github.com/brunotrolo/my-opencode-config'), 'brunotrolo/my-opencode-config');
  });

  it('parses an https URL with a trailing .git', () => {
    assert.strictEqual(parseGitHubRepoIdentifier('https://github.com/brunotrolo/my-opencode-config.git'), 'brunotrolo/my-opencode-config');
  });

  it('parses an https URL with embedded credentials', () => {
    assert.strictEqual(
      parseGitHubRepoIdentifier('https://user:token@github.com/brunotrolo/my-opencode-config.git'),
      'brunotrolo/my-opencode-config'
    );
  });

  it('parses a scp-style ssh URL (git@github.com:owner/repo.git)', () => {
    assert.strictEqual(parseGitHubRepoIdentifier('git@github.com:brunotrolo/my-opencode-config.git'), 'brunotrolo/my-opencode-config');
  });

  it('parses an ssh:// URL', () => {
    assert.strictEqual(parseGitHubRepoIdentifier('ssh://git@github.com/brunotrolo/my-opencode-config.git'), 'brunotrolo/my-opencode-config');
  });

  it('is case-insensitive about the github.com host', () => {
    assert.strictEqual(parseGitHubRepoIdentifier('https://GitHub.com/brunotrolo/my-opencode-config'), 'brunotrolo/my-opencode-config');
  });

  it('returns null for a non-GitHub remote', () => {
    assert.strictEqual(parseGitHubRepoIdentifier('https://gitlab.com/brunotrolo/my-opencode-config'), null);
    assert.strictEqual(parseGitHubRepoIdentifier('/local/path/to/remote.git'), null);
    assert.strictEqual(parseGitHubRepoIdentifier(''), null);
  });
});
