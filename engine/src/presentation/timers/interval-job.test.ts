import { describe, expect, it, vi } from 'vitest';
import { IntervalJob } from './interval-job.js';
import { FakeTimers } from './testing/fake-timers.js';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('IntervalJob', () => {
  it('runs on each tick and not before', async () => {
    const timers = new FakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const job = new IntervalJob({ name: 'j', run, intervalMs: 1000, logger: logger(), timers });
    job.start();
    expect(run).not.toHaveBeenCalled();
    expect(timers.delays).toEqual([1000]);
    timers.fire();
    expect(run).toHaveBeenCalledTimes(1);
    await job.stop();
  });

  it('runs once immediately when asked', async () => {
    const timers = new FakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const job = new IntervalJob({
      name: 'j',
      run,
      intervalMs: 1000,
      logger: logger(),
      timers,
      immediate: true,
    });
    job.start();
    expect(run).toHaveBeenCalledTimes(1);
    await job.stop();
  });

  it('skips a tick while the previous run is still going', async () => {
    const timers = new FakeTimers();
    const gate = deferred();
    const run = vi.fn().mockReturnValue(gate.promise);
    const job = new IntervalJob({ name: 'j', run, intervalMs: 10, logger: logger(), timers });
    job.start();
    timers.fire();
    timers.fire();
    timers.fire();
    expect(run).toHaveBeenCalledTimes(1);
    gate.resolve();
    await job.stop();
  });

  it('logs a failing run and still runs the next tick', async () => {
    const timers = new FakeTimers();
    const log = logger();
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const job = new IntervalJob({ name: 'poll', run, intervalMs: 10, logger: log, timers });
    job.start();
    timers.fire();
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith('poll failed', { error: 'boom' }),
    );
    timers.fire();
    expect(run).toHaveBeenCalledTimes(2);
    await job.stop();
  });

  it('re-reads a dynamic interval before every tick', async () => {
    const timers = new FakeTimers();
    let ms = 100;
    const run = vi.fn().mockResolvedValue(undefined);
    const job = new IntervalJob({ name: 'j', run, intervalMs: () => ms, logger: logger(), timers });
    job.start();
    ms = 250;
    timers.fire();
    await job.stop();
    expect(timers.delays).toEqual([100, 250]);
  });

  it('stop waits for the run in flight and cancels the next tick', async () => {
    const timers = new FakeTimers();
    const gate = deferred();
    const run = vi.fn().mockReturnValue(gate.promise);
    const job = new IntervalJob({ name: 'j', run, intervalMs: 10, logger: logger(), timers });
    job.start();
    timers.fire();
    let stopped = false;
    const stopping = job.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(timers.pending).toBe(false);
    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('trigger runs now, or once more after the run in flight', async () => {
    const timers = new FakeTimers();
    const gate = deferred();
    const run = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
    const job = new IntervalJob({ name: 'j', run, intervalMs: 10, logger: logger(), timers });
    job.start();
    job.trigger();
    job.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await job.stop();
  });
});
