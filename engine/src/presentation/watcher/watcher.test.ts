import { describe, expect, it, vi } from 'vitest';
import type { ConfigProvider } from '../../application/ports/config-provider.js';
import { FakeTimers } from '../timers/testing/fake-timers.js';
import { createPrWatcher } from './watcher.js';

describe('PR watcher', () => {
  it('polls once on start, then every watch.pollSeconds read from the config', async () => {
    const timers = new FakeTimers();
    let pollSeconds = 60;
    const config = { current: () => ({ watch: { pollSeconds } }) } as unknown as ConfigProvider;
    const execute = vi.fn().mockResolvedValue(undefined);
    const watcher = createPrWatcher({
      pollPullRequests: { execute },
      config,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      timers,
    });

    watcher.start();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(timers.delays).toEqual([60_000]);

    await new Promise((resolve) => setImmediate(resolve)); // let the first poll finish
    pollSeconds = 15;
    timers.fire();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(timers.delays).toEqual([60_000, 15_000]);
    await watcher.stop();
  });
});
