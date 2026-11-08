import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../errors.js';
import { buildTestApp } from '../testing/index.js';

const DAY = 86_400_000;

describe('GetUsage', () => {
  it('defaults to the last seven days ending now, grouped by day', async () => {
    const app = buildTestApp();
    const now = new Date(app.clock.now()).getTime();

    const report = await app.getUsage.execute({ groupBy: 'day' });

    expect(report.groupBy).toBe('day');
    expect(Date.parse(report.to)).toBe(now);
    expect(Date.parse(report.from)).toBe(now - 7 * DAY);
    expect(report.rows).toEqual([]);
    expect(report.total).toMatchObject({ runs: 0, costUsd: 0 });
  });

  it('counts a running run and marks task rows open or closed from the stage', async () => {
    const app = buildTestApp();
    const open = await app.seed.task({ stage: 'Context' });
    const closed = await app.seed.task({ stage: 'Context' });
    await app.uow.run((tx) => tx.tasks.save({ ...closed.task, stage: 'Done' }));
    const at = new Date(Date.parse(app.clock.now()) - DAY).toISOString();
    for (const [id, task, cost] of [
      ['r-open', open.task, 1],
      ['r-closed', closed.task, 2],
    ] as const) {
      await app.uow.run((tx) =>
        tx.runs.save({
          id,
          sessionId: `s-${id}`,
          role: 'worker',
          threadId: task.threadId,
          taskId: task.id,
          status: 'running',
          startedAt: at,
          finishedAt: null,
          costUsd: cost,
          turns: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          stopReason: null,
          modelUsage: {},
          exitCode: null,
          error: null,
        }),
      );
    }

    const report = await app.getUsage.execute({ groupBy: 'task' });

    expect(report.rows.map((r) => [r.key, r.status, r.stage, r.runs])).toEqual([
      [closed.task.id, 'closed', 'Done', 1],
      [open.task.id, 'open', 'Context', 1],
    ]);
    expect(report.total.stopReasons).toEqual({ running: 2 });
  });

  it.each([
    ['from after to', { from: '2026-03-10T00:00:00Z', to: '2026-03-09T00:00:00Z' }],
    ['from equal to to', { from: '2026-03-10T00:00:00Z', to: '2026-03-10T00:00:00Z' }],
    ['a window over 366 days', { from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }],
    ['a from in the future', { from: '2999-01-01T00:00:00Z' }],
  ])('rejects %s', async (_name, window) => {
    const app = buildTestApp();
    await expect(app.getUsage.execute({ groupBy: 'day', ...window })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});
