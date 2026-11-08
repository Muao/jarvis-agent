import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../errors.js';
import { parsePullRequestRef, pullRequestUrl } from './pull-request-ref.js';

describe('parsePullRequestRef (ADR-0018)', () => {
  it('reads a PR URL, with or without a trailing path or fragment', () => {
    for (const value of [
      'https://github.com/burnjohn/jarvis-sandbox/pull/41',
      'https://www.github.com/burnjohn/jarvis-sandbox/pull/41/files',
      'http://github.com/burnjohn/jarvis-sandbox/pull/41#issuecomment-99',
      '  https://github.com/burnjohn/jarvis-sandbox/pull/41?w=1  ',
    ]) {
      expect(parsePullRequestRef(value), value).toEqual({
        number: 41,
        repo: 'burnjohn/jarvis-sandbox',
        url: 'https://github.com/burnjohn/jarvis-sandbox/pull/41',
      });
    }
  });

  it('reads "owner/name#number"', () => {
    expect(parsePullRequestRef('burnjohn/jarvis-sandbox#7')).toEqual({
      number: 7,
      repo: 'burnjohn/jarvis-sandbox',
      url: 'https://github.com/burnjohn/jarvis-sandbox/pull/7',
    });
  });

  it('reads a bare number, and says it does not know the repo', () => {
    for (const value of ['41', '#41']) {
      expect(parsePullRequestRef(value), value).toEqual({ number: 41, repo: null, url: null });
    }
  });

  it('refuses what is not a pull request', () => {
    for (const value of [
      'the login PR',
      'https://github.com/burnjohn/jarvis-sandbox',
      'https://github.com/burnjohn/jarvis-sandbox/issues/41',
      'https://gitlab.com/burnjohn/x/pull/41',
      'burnjohn/jarvis-sandbox',
      '#0',
      '',
    ]) {
      expect(() => parsePullRequestRef(value), value).toThrowError(InvalidInputError);
    }
  });

  it('tells the caller how to name the repo when it refuses', () => {
    expect(() => parsePullRequestRef('the login PR')).toThrowError(/owner\/name#41.*`repo`/s);
  });

  it('builds the URL of a PR whose repo was resolved separately', () => {
    expect(pullRequestUrl({ owner: 'burnjohn', name: 'jarvis-sandbox' }, 41)).toBe(
      'https://github.com/burnjohn/jarvis-sandbox/pull/41',
    );
  });
});
