import { describe, expect, it } from 'vitest';
import { AllowedRepoResolver, RepoNotAllowedError } from './allowed-repo-resolver.js';
import type { GitHubAccountLookup } from './allowed-repo-resolver.js';

const account = (login: string): GitHubAccountLookup => ({
  botLogin: () => Promise.resolve(login),
});

describe('AllowedRepoResolver', () => {
  it('resolves a repo listed in repos.allow', async () => {
    const resolver = new AllowedRepoResolver(
      { allow: ['owner/name'], allowOwnerRepos: false },
      account('someone-else'),
      null,
    );
    await expect(resolver.resolve('owner/name')).resolves.toEqual({ owner: 'owner', repo: 'name' });
  });

  it('resolves a repo owned by the authenticated account when allowOwnerRepos is set', async () => {
    const resolver = new AllowedRepoResolver(
      { allow: [], allowOwnerRepos: true },
      account('the-owner'),
      null,
    );
    await expect(resolver.resolve('the-owner/some-repo')).resolves.toEqual({
      owner: 'the-owner',
      repo: 'some-repo',
    });
  });

  it('rejects a repo that is neither allow-listed nor owned by the account', async () => {
    const resolver = new AllowedRepoResolver(
      { allow: ['owner/name'], allowOwnerRepos: true },
      account('the-owner'),
      null,
    );
    await expect(resolver.resolve('someone-else/other-repo')).rejects.toThrow(RepoNotAllowedError);
  });

  it('does not call the GitHub API when allowOwnerRepos is false', async () => {
    let called = false;
    const resolver = new AllowedRepoResolver(
      { allow: [], allowOwnerRepos: false },
      {
        botLogin: () => {
          called = true;
          return Promise.resolve('irrelevant');
        },
      },
      null,
    );
    await expect(resolver.resolve('someone/repo')).rejects.toThrow(RepoNotAllowedError);
    expect(called).toBe(false);
  });

  it('rejects Jarvis own repository even if it is allow-listed', async () => {
    const resolver = new AllowedRepoResolver(
      { allow: ['jarvis-owner/jarvis'], allowOwnerRepos: false },
      account('irrelevant'),
      { owner: 'jarvis-owner', repo: 'jarvis' },
    );
    await expect(resolver.resolve('jarvis-owner/jarvis')).rejects.toThrow(RepoNotAllowedError);
  });

  it('rejects Jarvis own repository regardless of case', async () => {
    const resolver = new AllowedRepoResolver(
      { allow: [], allowOwnerRepos: true },
      account('Jarvis-Owner'),
      { owner: 'jarvis-owner', repo: 'jarvis' },
    );
    await expect(resolver.resolve('Jarvis-Owner/Jarvis')).rejects.toThrow(RepoNotAllowedError);
  });

  it('rejects malformed input', async () => {
    const resolver = new AllowedRepoResolver(
      { allow: [], allowOwnerRepos: false },
      account('x'),
      null,
    );
    await expect(resolver.resolve('not-a-slug')).rejects.toThrow(RepoNotAllowedError);
  });
});
