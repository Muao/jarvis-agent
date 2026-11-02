import { describe, expect, it } from 'vitest';
import { parseRemote } from './remote.js';

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
