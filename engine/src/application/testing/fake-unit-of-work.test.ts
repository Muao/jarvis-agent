import { createThread } from '../../domain/index.js';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './build-test-app.js';

const T0 = '2026-01-01T10:00:00.000Z';

describe('FakeUnitOfWork', () => {
  it('commits everything the work wrote', async () => {
    const app = buildTestApp();
    await app.uow.run(async (tx) => {
      await tx.threads.save(createThread({ id: 'a', title: 'A', at: T0 }));
      await tx.threads.save(createThread({ id: 'b', title: 'B', at: T0 }));
    });
    expect([...app.db.tables.threads.keys()]).toEqual(['a', 'b']);
  });

  it('undoes every write when the work throws', async () => {
    const app = buildTestApp();
    await expect(
      app.uow.run(async (tx) => {
        await tx.threads.save(createThread({ id: 'a', title: 'A', at: T0 }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(app.db.tables.threads.size).toBe(0);
  });

  it('keeps earlier commits when a later transaction fails', async () => {
    const app = buildTestApp();
    await app.uow.run((tx) => tx.threads.save(createThread({ id: 'a', title: 'A', at: T0 })));
    await app.uow
      .run(async (tx) => {
        await tx.threads.save(createThread({ id: 'b', title: 'B', at: T0 }));
        throw new Error('boom');
      })
      .catch(() => undefined);
    expect([...app.db.tables.threads.keys()]).toEqual(['a']);
  });

  it('runs transactions one after another', async () => {
    const app = buildTestApp();
    const order: string[] = [];
    await Promise.all([
      app.uow.run(async () => {
        order.push('first start');
        await Promise.resolve();
        order.push('first end');
      }),
      app.uow.run(async () => {
        order.push('second');
      }),
    ]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });

  it('does not reuse a task id after a rollback (sequence semantics)', async () => {
    const app = buildTestApp();
    await app.uow
      .run(async (tx) => {
        await tx.tasks.nextId();
        throw new Error('boom');
      })
      .catch(() => undefined);
    expect(await app.uow.run((tx) => tx.tasks.nextId())).toBe('T-2');
  });
});
