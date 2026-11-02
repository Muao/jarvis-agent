import { describe, expect, it } from 'vitest';
import { createTask, createThread, startRun, taskEvent, transition } from '../../domain/index.js';
import { assertTestDatabase, useTestDatabase } from '../../../test/db.js';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:05:00.000Z';

const pg = useTestDatabase();

async function seedTask(): Promise<void> {
  await pg.repos.threads.save(createThread({ id: 'th-1', title: 'Thread', at: NOW }));
  await pg.repos.tasks.save(
    createTask({ id: 'T-1', threadId: 'th-1', title: 'Task', branch: 'jarvis/T-1', at: NOW }),
  );
}

describe('PgUnitOfWork (ADR-0010)', () => {
  it('commits the task change and its journal row together', async () => {
    await seedTask();
    await pg.uow.run(async (tx) => {
      const task = await tx.tasks.get('T-1');
      const { task: next, event } = transition(task!, 'Context', {
        cause: 'worker_started',
        at: LATER,
      });
      await tx.tasks.save(next);
      await tx.journal.append(event);
    });

    expect((await pg.repos.tasks.get('T-1'))?.stage).toBe('Context');
    const journal = await pg.repos.journal.list('T-1');
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      type: 'stage_changed',
      data: { from: 'Intake', to: 'Context' },
    });
  });

  it('rolls the task change and the journal row back when the work throws', async () => {
    await seedTask();
    await expect(
      pg.uow.run(async (tx) => {
        const task = await tx.tasks.get('T-1');
        const { task: next, event } = transition(task!, 'Context', {
          cause: 'worker_started',
          at: LATER,
        });
        await tx.tasks.save(next);
        await tx.journal.append(event);
        await tx.threads.save(createThread({ id: 'th-2', title: 'Another', at: NOW }));
        throw new Error('use case failed');
      }),
    ).rejects.toThrow('use case failed');

    expect((await pg.repos.tasks.get('T-1'))?.stage).toBe('Intake');
    expect(await pg.repos.journal.list('T-1')).toEqual([]);
    expect(await pg.repos.threads.get('th-2')).toBeNull();
  });

  it('rolls back a failed database statement, including the writes before it', async () => {
    await seedTask();
    await expect(
      pg.uow.run(async (tx) => {
        await tx.journal.append(taskEvent('T-1', 'note', NOW, 'system'));
        await tx.journal.append(taskEvent('T-missing', 'note', NOW, 'system')); // FK violation
      }),
    ).rejects.toThrow();
    expect(await pg.repos.journal.list('T-1')).toEqual([]);
  });

  it('returns the work result and lets later transactions see committed rows', async () => {
    const id = await pg.uow.run((tx) => tx.tasks.nextId());
    expect(id).toBe('T-1');
    expect(await pg.uow.run((tx) => tx.tasks.nextId())).toBe('T-2');
  });

  it('never reuses a task id after a rollback (sequence-backed)', async () => {
    await expect(
      pg.uow.run(async (tx) => {
        expect(await tx.tasks.nextId()).toBe('T-1');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await pg.repos.tasks.nextId()).toBe('T-2');
  });

  it('keeps run events in order inside a unit of work and rolls them back with it', async () => {
    await seedTask();
    await pg.repos.sessions.save({
      id: 's-1',
      role: 'worker',
      threadId: 'th-1',
      taskId: 'T-1',
      claudeSessionId: null,
    });
    await pg.repos.runs.save(
      startRun({
        id: 'r-1',
        sessionId: 's-1',
        role: 'worker',
        threadId: 'th-1',
        taskId: 'T-1',
        at: NOW,
      }),
    );

    await pg.uow.run(async (tx) => {
      await tx.runs.appendEvent('r-1', { kind: 'text', payload: { text: 'a' } }, NOW);
      await tx.runs.appendEvent('r-1', { kind: 'text', payload: { text: 'b' } }, NOW);
    });
    await expect(
      pg.uow.run(async (tx) => {
        await tx.runs.appendEvent('r-1', { kind: 'text', payload: { text: 'lost' } }, NOW);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const next = await pg.repos.runs.appendEvent(
      'r-1',
      { kind: 'text', payload: { text: 'c' } },
      NOW,
    );

    expect(next.seq).toBe(2);
    expect(await pg.repos.runs.lastEvent('r-1')).toEqual(next);
  });

  it('numbers concurrent appends to one run without gaps or duplicates', async () => {
    await seedTask();
    await pg.repos.sessions.save({
      id: 's-1',
      role: 'worker',
      threadId: 'th-1',
      taskId: 'T-1',
      claudeSessionId: null,
    });
    await pg.repos.runs.save(
      startRun({
        id: 'r-1',
        sessionId: 's-1',
        role: 'worker',
        threadId: 'th-1',
        taskId: 'T-1',
        at: NOW,
      }),
    );

    const stored = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        pg.repos.runs.appendEvent('r-1', { kind: 'text', payload: { text: String(i) } }, NOW),
      ),
    );
    expect(stored.map((e) => e.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
  });

  it('rejects a nested run instead of opening a second connection', async () => {
    await expect(
      pg.uow.run(async () => {
        await pg.uow.run(async () => undefined);
      }),
    ).rejects.toThrow(/inside another run/);
    // The pool is still healthy afterwards.
    expect(await pg.uow.run(async () => 'ok')).toBe('ok');
  });
});

describe('append-only journals (ADR-0010)', () => {
  it('rejects UPDATE and DELETE on task_events', async () => {
    await seedTask();
    await pg.repos.journal.append(taskEvent('T-1', 'note', NOW, 'system', { a: 1 }));

    await expect(pg.pool.query(`update task_events set type = 'tampered'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(pg.pool.query('delete from task_events')).rejects.toThrow(/append-only/);
    expect(await pg.repos.journal.list('T-1')).toHaveLength(1);
  });

  it('rejects UPDATE and DELETE on run_events', async () => {
    await seedTask();
    await pg.repos.sessions.save({
      id: 's-1',
      role: 'worker',
      threadId: 'th-1',
      taskId: 'T-1',
      claudeSessionId: null,
    });
    await pg.repos.runs.save(
      startRun({
        id: 'r-1',
        sessionId: 's-1',
        role: 'worker',
        threadId: 'th-1',
        taskId: 'T-1',
        at: NOW,
      }),
    );
    await pg.repos.runs.appendEvent('r-1', { kind: 'text', payload: { text: 'a' } }, NOW);

    await expect(pg.pool.query(`update run_events set kind = 'error'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(pg.pool.query('delete from run_events')).rejects.toThrow(/append-only/);
  });
});

describe('test harness safety', () => {
  it('refuses databases whose name does not end in _test', () => {
    expect(() => assertTestDatabase('postgres://u:p@127.0.0.1:5433/jarvis')).toThrow(/_test/);
    expect(() => assertTestDatabase('postgres://u:p@127.0.0.1:5433/jarvis_test')).not.toThrow();
  });
});
