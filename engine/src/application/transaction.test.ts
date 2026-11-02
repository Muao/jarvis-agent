import { describe, expect, it } from 'vitest';
import { buildTestApp } from './testing/build-test-app.js';

describe('after-commit effects are best-effort', () => {
  it('a failing owner channel is logged, the use case succeeds and the other effects still run', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    app.owner.deliver = async () => {
      throw new Error('sse down');
    };

    const created = await app.createTask.execute(app.identity.dispatcher(thread.id), {
      title: 't',
      description: 'd',
    });

    expect(app.task(created.taskId).stage).toBe('Intake');
    expect(app.runs.calls).toEqual([
      { type: 'worker_run', taskId: created.taskId, reason: 'start' },
    ]);
    expect(app.events.published).toContainEqual({ type: 'task', id: created.taskId });
    expect(app.logger.entries).toEqual([
      {
        level: 'warn',
        message: 'after-commit effect failed',
        context: { effect: 'message_created', error: 'sse down' },
      },
    ]);
  });

  it('a failing run coordinator does not fail the use case either', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    app.runs.stopTaskRuns = async () => {
      throw new Error('cannot stop');
    };

    await app.cancelTask.execute({ taskId: task.id });

    expect(app.task(task.id).stage).toBe('Cancelled');
    expect(app.logger.entries.map((e) => e.context.effect)).toEqual(['stop_task_runs']);
  });

  it('a rolled-back use case still sends and logs nothing', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    app.worktrees.failNext(new Error('git failed'));

    await expect(
      app.createTask.execute(app.identity.dispatcher(thread.id), { title: 't', description: 'd' }),
    ).rejects.toThrow('git failed');

    expect(app.logger.entries).toEqual([]);
    expect(app.owner.delivered).toEqual([]);
  });
});
