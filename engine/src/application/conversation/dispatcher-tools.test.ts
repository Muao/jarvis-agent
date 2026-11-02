import { describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('Reply', () => {
  it('posts a jarvis message into the run thread and notifies the owner', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    const { messageId } = await app.reply.execute(app.identity.dispatcher(thread.id), {
      text: 'Task T-1 created.',
    });

    expect(app.message(messageId)).toMatchObject({
      kind: 'jarvis',
      threadId: thread.id,
      body: { text: 'Task T-1 created.' },
    });
    expect(app.owner.delivered.map((m) => m.id)).toEqual([messageId]);
  });

  it('is closed to workers', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task();

    await expect(
      app.reply.execute(app.identity.worker(task), { text: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(app.owner.delivered).toEqual([]);
  });
});

describe('ListTasks', () => {
  it('reports only active tasks with stage, what they wait for and the PR link', async () => {
    const app = buildTestApp();
    const spec = await app.seed.task({ stage: 'Spec Review' });
    const impl = await app.seed.task({ stage: 'Implementing' });
    const done = await app.seed.task({ stage: 'Implementing' });
    await app.cancelTask.execute({ taskId: done.task.id });
    await app.uow.run((tx) =>
      tx.tasks.save({ ...impl.task, pr: { number: 5, url: 'https://github.com/o/r/pull/5' } }),
    );
    app.runs.queued.add(impl.task.id);

    const list = await app.listTasks.execute(app.identity.dispatcher(spec.thread.id));

    expect(list.tasks.map((t) => [t.id, t.stage, t.waitingFor])).toEqual([
      [spec.task.id, 'Spec Review', 'owner'],
      [impl.task.id, 'Implementing', 'worker slot'],
    ]);
    expect(list.text).toContain(`${spec.task.id} Seeded task: Spec Review, waiting for owner`);
    expect(list.text).toContain('https://github.com/o/r/pull/5');
    expect(list.text).not.toContain(done.task.id);
  });

  it('says so when nothing is active', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    const list = await app.listTasks.execute(app.identity.dispatcher(thread.id));

    expect(list).toEqual({ tasks: [], text: 'No active tasks.' });
  });

  it('changes nothing', async () => {
    const app = buildTestApp();
    const { thread } = await app.seed.task();

    await app.listTasks.execute(app.identity.dispatcher(thread.id));

    expect(app.owner.delivered).toEqual([]);
    expect(app.runs.calls).toEqual([]);
  });
});

describe('SendToTask', () => {
  it('queues the message for the worker of that task and hands it over', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Implementing' });
    const other = await app.seed.thread();

    await app.sendToTask.execute(app.identity.dispatcher(other.id), {
      taskId: task.id,
      message: 'also update the docs',
    });

    const queued = await app.uow.run((tx) => tx.messages.queuedWorkerInput(task.id));
    expect(queued.map((m) => [m.threadId, m.body.text])).toEqual([
      [thread.id, 'also update the docs'],
    ]);
    expect(app.runs.calls).toEqual([{ type: 'deliver_to_worker', taskId: task.id }]);
    expect(app.db.tables.journal.at(-1)).toMatchObject({ type: 'owner_input', actor: 'agent' });
  });

  it('rejects an unknown task', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await expect(
      app.sendToTask.execute(app.identity.dispatcher(thread.id), { taskId: 'T-99', message: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a finished task', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Implementing' });
    await app.cancelTask.execute({ taskId: task.id });
    app.clearEffects();

    await expect(
      app.sendToTask.execute(app.identity.dispatcher(thread.id), { taskId: task.id, message: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(app.runs.calls).toEqual([]);
  });

  it('is closed to workers', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task();

    await expect(
      app.sendToTask.execute(app.identity.worker(task), { taskId: task.id, message: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
