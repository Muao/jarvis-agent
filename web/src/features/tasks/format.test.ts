import { describe, expect, it } from 'vitest';
import { describeTokens, formatTokens, totalTokens } from './format';

// A real one-turn run: almost everything is the context re-read from the cache.
const usage = { input: 6, output: 693, cacheWrite: 21_267, cacheRead: 79_951 };

describe('token formatting', () => {
  it('counts every kind of token in the total', () => {
    expect(totalTokens(usage)).toBe(101_917);
  });

  it('shows the total first, then the output', () => {
    expect(formatTokens(usage)).toBe('101.9K · 693 out');
  });

  it('spells the split out for the tooltip', () => {
    expect(describeTokens(usage)).toBe(
      '6 input · 693 output · 21,267 cache write · 79,951 cache read',
    );
  });
});
