import { describe, expect, it } from 'vitest';
import { defaultGitHubRepo, parseRemote } from './remote.js';

describe('parseRemote', () => {
  it.each([
    ['git@github.com:acme/widgets.git', 'acme', 'widgets'],
    ['git@github.com:acme/widgets', 'acme', 'widgets'],
    ['https://github.com/acme/widgets.git', 'acme', 'widgets'],
    ['https://github.com/acme/widgets', 'acme', 'widgets'],
    ['https://github.com/acme/widgets/', 'acme', 'widgets'],
    ['https://x-access-token:abc@github.com/acme/my.repo.git', 'acme', 'my.repo'],
    ['ssh://git@github.com/acme/widgets.git', 'acme', 'widgets'],
  ])('%s', (url, owner, repo) => {
    expect(parseRemote(url)).toEqual({ owner, repo });
  });

  it('returns null for other hosts and garbage', () => {
    expect(parseRemote('git@gitlab.com:a/b.git')).toBeNull();
    expect(parseRemote('not a url')).toBeNull();
  });
});

describe('defaultGitHubRepo', () => {
  it("prefers repo.path's GitHub remote", () => {
    expect(defaultGitHubRepo('git@github.com:acme/widgets.git', ['other/repo'])).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('falls back to the first allow-listed repo when repo.path has no remote', () => {
    expect(defaultGitHubRepo(null, ['acme/blog', 'acme/shop'])).toEqual({
      owner: 'acme',
      repo: 'blog',
    });
  });

  it('falls back to the allow-list when the remote is not GitHub', () => {
    expect(defaultGitHubRepo('https://gitlab.com/acme/widgets.git', ['acme/blog'])).toEqual({
      owner: 'acme',
      repo: 'blog',
    });
  });

  it('is null with neither a GitHub remote nor an allow-list', () => {
    expect(defaultGitHubRepo(null, [])).toBeNull();
    expect(defaultGitHubRepo('/srv/local.git', [])).toBeNull();
  });
});
