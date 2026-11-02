import { describe, expect, it } from 'vitest';
import { SystemClock, startOfLocalDay } from './system-clock.js';

describe('SystemClock', () => {
  it('returns the current time as ISO 8601', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    expect(new Date(now).toISOString()).toBe(now);
    expect(Date.parse(now)).toBeGreaterThanOrEqual(before);
  });
});

describe('startOfLocalDay', () => {
  it('returns local midnight of the same day', () => {
    const noon = new Date(2026, 5, 15, 12, 34, 56);
    const start = new Date(startOfLocalDay(noon.toISOString()));
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(5);
    expect(start.getDate()).toBe(15);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
  });
});
