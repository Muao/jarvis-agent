import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp } from '../testing/index.js';
import { HEALTH_DEADLINE_MS } from './get-health.js';

afterEach(() => vi.useRealTimers());

describe('GetHealth', () => {
  it('reports the database failed when the ping never answers, after the deadline', async () => {
    vi.useFakeTimers();
    const app = buildTestApp();
    app.database.ping = () => new Promise(() => undefined);

    const pending = app.getHealth.execute();
    await vi.advanceTimersByTimeAsync(HEALTH_DEADLINE_MS);

    expect(await pending).toMatchObject({ status: 'failed', database: 'failed', activeRuns: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports the database failed when counting the running runs throws', async () => {
    const app = buildTestApp();
    app.uow.run = () => Promise.reject(new Error('relation does not exist'));

    expect(await app.getHealth.execute()).toMatchObject({ status: 'failed', database: 'failed' });
  });
});
