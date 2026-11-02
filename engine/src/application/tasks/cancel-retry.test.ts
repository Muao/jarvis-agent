import { describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('CancelTask', () => {
  it('cancels, stops the runs and says what is left behind (branch only)', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Implementing' });

    await app.cancelTask.execute({ taskId: task.id, reason: 'not needed' });

    expect(app.task(task.id)).toMatchObject({ stage: 'Cancelled', reason: 'not needed' });
    expect(app.runs.calls).toEqual([{ type: 'stop_task_runs', taskId: task.id }]);
    const [note] = app.messagesOf(thread.id).filter((m) => m.kind === 'system');
    expect(note?.body.text).toBe(
      `Task ${task.id} cancelled. Nothing was deleted: branch jarvis/${task.id} remains.`,
    );
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      actor: 'owner',
      data: { to: 'Cancelled', cause: 'owner_cancelled' },
    });
  });

  it('names the PR that remains', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Reviewing' });
    await app.reportPr.execute(app.identity.worker(task), {
      number: 4,
      url: 'https://x.dev/pull/4',
    });

    await app.cancelTask.execute({ taskId: task.id });

    const note = app.messagesOf(thread.id).find((m) => m.kind === 'system');
    expect(note?.body.text).toContain(
      `branch jarvis/${task.id} and PR #4 (https://x.dev/pull/4) remain`,
    );
  });

  it('works from Blocked and Spec Review (waiting for the owner)', async () => {
    const app = buildTestApp();
    const a = await app.seed.task({ stage: 'Implementing' });
    await app.askOwner.execute(app.identity.worker(a.task), { question: 'q?' });
    const b = await app.seed.task({ stage: 'Spec Review' });

    await app.cancelTask.execute({ taskId: a.task.id });
    await app.cancelTask.execute({ taskId: b.task.id });

    expect([app.task(a.task.id).stage, app.task(b.task.id).stage]).toEqual([
      'Cancelled',
      'Cancelled',
    ]);
  });

  it('refuses to cancel a finished task and an unknown one', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    await app.cancelTask.execute({ taskId: task.id });
    app.clearEffects();

    await expect(app.cancelTask.execute({ taskId: task.id })).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    await expect(app.cancelTask.execute({ taskId: 'T-99' })).rejects.toBeInstanceOf(NotFoundError);
    expect(app.runs.calls).toEqual([]);
  });

  it('the dispatcher tool needs a dispatcher identity', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Implementing' });

    await expect(
      app.cancelTask.execute({ taskId: task.id }, app.identity.worker(task)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await app.cancelTask.execute({ taskId: task.id }, app.identity.dispatcher(thread.id));

    expect(app.task(task.id).stage).toBe('Cancelled');
  });
});

describe('RetryStage', () => {
  async function failedTask() {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Verifying' });
    const identity = app.identity.worker(seeded.task);
    for (let i = 0; i < 4; i++) {
      await app.reportChecks.execute(identity, { passed: false, summary: 'red' });
    }
    app.clearEffects();
    return { app, ...seeded };
  }

  it('returns a Failed task to the stage it failed in with fresh attempts and asks for a run', async () => {
    const { app, task } = await failedTask();
    expect(app.task(task.id).stage).toBe('Failed');

    await app.retryStage.execute(task.id);

    expect(app.task(task.id)).toMatchObject({
      stage: 'Verifying',
      resumeStage: null,
      reason: null,
      counters: { checkRetries: 0 },
    });
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'retry' }]);
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      actor: 'owner',
      data: { from: 'Failed', to: 'Verifying', cause: 'owner_retry' },
    });
  });

  it('asks for a new run of a working task without changing its stage', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await app.retryStage.execute(task.id);

    expect(app.task(task.id).stage).toBe('Implementing');
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'retry' }]);
    expect(app.db.tables.journal.at(-1)).toMatchObject({ type: 'retry_requested' });
  });

  it.each(['Spec Review', 'PR Open'] as const)('refuses a task waiting in %s', async (stage) => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage });

    await expect(app.retryStage.execute(task.id)).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    expect(app.runs.calls).toEqual([]);
  });

  it('refuses a cancelled task', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    await app.cancelTask.execute({ taskId: task.id });

    await expect(app.retryStage.execute(task.id)).rejects.toMatchObject({
      code: 'illegal_transition',
    });
  });
});
