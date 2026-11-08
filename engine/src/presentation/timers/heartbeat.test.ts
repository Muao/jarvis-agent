import { describe, expect, it, vi } from 'vitest';
import type { Application } from '../../application/index.js';
import { HttpHeartbeat, type FetchFn } from '../../infrastructure/heartbeat/http-heartbeat.js';
import { createHeartbeatTimer, HEARTBEAT_INTERVAL_MS } from './heartbeat.js';
import { startTimers } from './index.js';
import { FakeTimers } from './testing/fake-timers.js';

const SECRET_URL = 'https://hc-ping.example/ping/secret-token-123';

function health(status: 'ok' | 'degraded' | 'failed') {
  return { execute: vi.fn().mockResolvedValue({ status }) };
}

/** Records the exact URL of every call; `answer` decides what the endpoint does. */
function fakeFetch(answer: () => Promise<{ ok: boolean; status: number }>) {
  const urls: string[] = [];
  const fn: FetchFn = (url) => {
    urls.push(url);
    return answer();
  };
  return { fn, urls };
}

const okAnswer = () => Promise.resolve({ ok: true, status: 200 });

function setup(status: 'ok' | 'degraded' | 'failed', answer = okAnswer) {
  const logs: string[] = [];
  const logger = {
    info: vi.fn((m: string, c?: object) => logs.push(JSON.stringify([m, c]))),
    warn: vi.fn((m: string, c?: object) => logs.push(JSON.stringify([m, c]))),
    error: vi.fn((m: string, c?: object) => logs.push(JSON.stringify([m, c]))),
  };
  const timers = new FakeTimers();
  const { fn, urls } = fakeFetch(answer);
  const timer = createHeartbeatTimer({
    health: health(status),
    heartbeat: new HttpHeartbeat(SECRET_URL, fn),
    logger,
    timers,
  });
  /** Fires one tick and waits for it to finish. */
  const tick = async () => {
    timers.fire(HEARTBEAT_INTERVAL_MS);
    await timer.stop();
    timer.start();
  };
  return { logger, logs, timers, timer, urls, tick };
}

describe('heartbeat timer', () => {
  it.each(['ok', 'degraded'] as const)('pings the base URL when health is %s', async (status) => {
    const { timer, urls, tick, timers } = setup(status);
    timer.start();
    expect(timers.delays).toEqual([HEARTBEAT_INTERVAL_MS]);
    await tick();
    expect(urls).toEqual([SECRET_URL]);
    await timer.stop();
  });

  it('pings <url>/fail when health is failed', async () => {
    const { timer, urls, tick } = setup('failed');
    timer.start();
    await tick();
    expect(urls).toEqual([`${SECRET_URL}/fail`]);
    await timer.stop();
  });

  it('swallows a rejected fetch, warns with the event, keeps ticking and never logs the URL', async () => {
    const { timer, logger, logs, timers, tick } = setup('ok', () =>
      Promise.reject(new TypeError(`fetch failed ${SECRET_URL}`)),
    );
    timer.start();
    await tick();
    expect(logger.warn).toHaveBeenCalledWith('heartbeat failed', {
      event: 'heartbeat.failed',
      reason: 'request did not complete (TypeError)',
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(timers.pending).toBe(true);
    expect(logs.join('\n')).not.toContain('secret-token-123');
    await timer.stop();
  });

  it('treats a non-2xx answer like a rejection', async () => {
    const { timer, logger, logs, tick } = setup('ok', () =>
      Promise.resolve({ ok: false, status: 404 }),
    );
    timer.start();
    await tick();
    expect(logger.warn).toHaveBeenCalledWith('heartbeat failed', {
      event: 'heartbeat.failed',
      reason: 'endpoint answered HTTP 404',
    });
    expect(logs.join('\n')).not.toContain('secret-token-123');
    await timer.stop();
  });

  it('stop() with a fetch in flight completes once the request timeout aborts it', async () => {
    const abort = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
    const hanging: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'TimeoutError')),
        );
      });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const timers = new FakeTimers();
    const timer = createHeartbeatTimer({
      health: health('ok'),
      heartbeat: new HttpHeartbeat(SECRET_URL, hanging),
      logger,
      timers,
    });
    timer.start();
    timers.fire(HEARTBEAT_INTERVAL_MS);
    let stopped = false;
    const stopping = timer.stop().then(() => (stopped = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    abort.abort();
    await stopping;
    expect(logger.warn).toHaveBeenCalledWith('heartbeat failed', {
      event: 'heartbeat.failed',
      reason: 'request did not complete (TimeoutError)',
    });
    spy.mockRestore();
  });

  it('warns instead of throwing when the health query itself fails', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const timers = new FakeTimers();
    const timer = createHeartbeatTimer({
      health: { execute: vi.fn().mockRejectedValue(new Error('db gone')) },
      heartbeat: { beat: vi.fn() },
      logger,
      timers,
    });
    timer.start();
    timers.fire(HEARTBEAT_INTERVAL_MS);
    await timer.stop();
    expect(logger.warn).toHaveBeenCalledWith('heartbeat failed', {
      event: 'heartbeat.failed',
      reason: 'db gone',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('startTimers and the heartbeat', () => {
  const app = {
    getHealth: health('ok'),
    pollPullRequests: { execute: vi.fn().mockResolvedValue(undefined) },
    detectStalls: { execute: vi.fn().mockResolvedValue(undefined) },
    enforceTaskTimeouts: { execute: vi.fn().mockResolvedValue(undefined) },
    expireOrphanedPermissions: { execute: vi.fn().mockResolvedValue(undefined) },
    scheduler: { resumeQueued: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Application;

  function start(withHeartbeat: boolean) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const timers = new FakeTimers();
    const running = startTimers(app, {
      config: { current: () => ({ watch: { pollSeconds: 60 } }) } as never,
      onConfigChange: () => () => {},
      logger,
      checks: { check: vi.fn().mockResolvedValue({ status: 'ok', summary: '', details: [] }) },
      timers,
      ...(withHeartbeat ? { heartbeat: { beat: vi.fn() } } : {}),
    });
    return { running, timers, logger };
  }

  // The resume job also ticks every 60 s, so the heartbeat shows as one more 60 s timer.
  const sixtySecondTimers = (timers: FakeTimers) =>
    timers.delays.filter((ms) => ms === HEARTBEAT_INTERVAL_MS).length;

  it('starts one timer fewer and logs nothing without a heartbeat', async () => {
    const without = start(false);
    const withIt = start(true);
    expect(sixtySecondTimers(withIt.timers) - sixtySecondTimers(without.timers)).toBe(1);
    const { running, logger } = without;
    await withIt.running.stop();
    await running.stop();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('starts the 60 s timer with a heartbeat and stops it with the others', async () => {
    const { running, timers } = start(true);
    await running.stop();
    expect(timers.pending).toBe(false);
  });
});
