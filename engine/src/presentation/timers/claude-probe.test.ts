import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_PROBE_INTERVAL_MS, createClaudeProbeRefresh } from './claude-probe.js';
import { FakeTimers } from './testing/fake-timers.js';

function setup() {
  const checks = { check: vi.fn().mockResolvedValue({ status: 'ok', summary: '', details: [] }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const timers = new FakeTimers();
  const refresh = createClaudeProbeRefresh({ checks, logger, timers });
  return { checks, logger, timers, refresh };
}

describe('claude probe refresh', () => {
  it('probes claude right away and again every 5 minutes, and nothing else', async () => {
    const { checks, timers, refresh } = setup();
    refresh.start();
    await vi.waitFor(() => expect(checks.check).toHaveBeenCalledTimes(1));
    expect(timers.delays).toEqual([CLAUDE_PROBE_INTERVAL_MS]);

    // A tick that finds the previous one in flight is skipped, so retry the firing until the second probe runs.
    await vi.waitFor(() => {
      timers.fire(CLAUDE_PROBE_INTERVAL_MS);
      expect(checks.check).toHaveBeenCalledTimes(2);
    });
    await refresh.stop();
    expect(timers.pending).toBe(false);

    expect(checks.check.mock.calls).toEqual([['claude'], ['claude']]);
  });

  it('logs a failing probe and keeps ticking', async () => {
    const { checks, logger, timers, refresh } = setup();
    checks.check.mockRejectedValueOnce(new Error('boom'));
    refresh.start();
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith('claude probe failed', { error: 'boom' }),
    );
    expect(timers.pending).toBe(true);
    await refresh.stop();
    expect(timers.pending).toBe(false);
  });
});
