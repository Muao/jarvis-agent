import { describe, expect, it } from 'vitest';
import { formatMessageTime } from './messageTime';

describe('formatMessageTime', () => {
  const now = new Date(2026, 10, 10, 23, 0, 0);

  it('shows only the clock for a message from today', () => {
    const at = new Date(2026, 10, 10, 22, 6, 18).toISOString();
    expect(formatMessageTime(at, now).short).toBe('22:06');
  });

  it('adds the day for a message from an earlier day', () => {
    const at = new Date(2026, 10, 9, 8, 5, 0).toISOString();
    expect(formatMessageTime(at, now).short).toBe('9 Nov, 08:05');
  });

  it('puts seconds and the year in the full form', () => {
    const at = new Date(2026, 10, 10, 22, 6, 18).toISOString();
    expect(formatMessageTime(at, now).full).toContain('22:06:18');
    expect(formatMessageTime(at, now).full).toContain('2026');
  });

  it('returns the input unchanged when it is not a date', () => {
    expect(formatMessageTime('nope', now)).toEqual({ short: 'nope', full: 'nope' });
  });
});
