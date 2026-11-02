import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact.js';

describe('createRedactor', () => {
  it('masks every occurrence of a secret', () => {
    const redact = createRedactor(['s3cret-value']);
    expect(redact('a s3cret-value b s3cret-value')).toBe('a [redacted] b [redacted]');
  });

  it('masks the URL-encoded form', () => {
    const redact = createRedactor(['p@ss word/1']);
    expect(redact('https://x?k=p%40ss%20word%2F1')).toBe('https://x?k=[redacted]');
  });

  it('ignores empty secrets', () => {
    const redact = createRedactor(['', 'abc']);
    expect(redact('hello abc')).toBe('hello [redacted]');
    expect(createRedactor([''])('unchanged')).toBe('unchanged');
  });

  it('masks token shapes without knowing the value', () => {
    const redact = createRedactor([]);
    const text = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11AAAAAAA0abcdefghij_klmnop',
      'xoxb-123456789012-abcdefghij',
      'xoxp-123456789012-abcdefghij',
      'xoxa-123456789012-abcdefghij',
    ].join(' ');
    expect(redact(text)).toBe('[redacted] [redacted] [redacted] [redacted] [redacted]');
  });

  it('leaves ordinary text alone', () => {
    expect(createRedactor(['k'.repeat(8)])('nothing to see, ghp_ short')).toBe(
      'nothing to see, ghp_ short',
    );
  });
});
