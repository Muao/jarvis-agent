import { describe, expect, it, vi } from 'vitest';
import { FakeTimers } from './testing/fake-timers.js';
import { createSupervision, RESUME_INTERVAL_MS, SUPERVISION_INTERVAL_MS } from './supervision.js';

type Deps = Parameters<typeof createSupervision>[0];

function setup() {
  const app = {
    detectStalls: { execute: vi.fn().mockResolvedValue(undefined) },
    enforceTaskTimeouts: { execute: vi.fn().mockResolvedValue(undefined) },
    expireOrphanedPermissions: { execute: vi.fn().mockResolvedValue(0) },
    scheduler: { resumeQueued: vi.fn().mockResolvedValue(undefined) },
  };
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const timers = new FakeTimers();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const supervision = createSupervision({
    app: app as unknown as Deps['app'],
    onConfigChange: (l) => {
      listener = l;
      return unsubscribe;
    },
    logger,
    timers,
  });
  return { app, timers, logger, supervision, changeConfig: () => listener?.(), unsubscribe };
}

describe('supervision', () => {
  it('schedules the 30 s supervisors and the 60 s queue resume', async () => {
    const { timers, supervision } = setup();
    supervision.start();
    expect(timers.delays).toEqual([SUPERVISION_INTERVAL_MS, RESUME_INTERVAL_MS]);
    await supervision.stop();
  });

  it('runs stalls, timeouts and orphaned permissions each tick, even when one fails', async () => {
    const { app, timers, logger, supervision } = setup();
    app.detectStalls.execute.mockRejectedValueOnce(new Error('db down'));
    supervision.start();
    timers.fire(SUPERVISION_INTERVAL_MS);
    await supervision.stop();
    expect(app.detectStalls.execute).toHaveBeenCalledTimes(1);
    expect(app.enforceTaskTimeouts.execute).toHaveBeenCalledTimes(1);
    expect(app.expireOrphanedPermissions.execute).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('detect stalls failed', { error: 'db down' });
    expect(app.scheduler.resumeQueued).not.toHaveBeenCalled();
  });

  it('resumes queued runs every 60 s', async () => {
    const { app, timers, supervision } = setup();
    supervision.start();
    timers.fire(RESUME_INTERVAL_MS);
    await supervision.stop();
    expect(app.scheduler.resumeQueued).toHaveBeenCalledTimes(1);
  });

  it('resumes queued runs on a config change and stops listening on stop', async () => {
    const { app, supervision, changeConfig, unsubscribe } = setup();
    supervision.start();
    changeConfig();
    expect(app.scheduler.resumeQueued).toHaveBeenCalledTimes(1);
    await supervision.stop();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
