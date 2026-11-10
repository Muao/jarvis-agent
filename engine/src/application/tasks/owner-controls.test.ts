import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../testing/index.js';

describe('Owner controls: hold, resume, model', () => {
  it('puts a task on hold and resumes it, telling the thread each time', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Intake' });

    await app.holdTask.execute({ taskId: task.id });
    expect(app.task(task.id)).toMatchObject({ held: true, stage: 'Intake' });

    await app.resumeTask.execute({ taskId: task.id });
    expect(app.task(task.id).held).toBe(false);
    expect(app.runs.calls).toContainEqual({ type: 'resume_queued' });

    const system = app
      .messagesOf(thread.id)
      .filter((m) => m.kind === 'system')
      .map((m) => m.body.text);
    expect(system).toEqual([
      `${task.id} is on hold: no worker run starts until you resume it.`,
      `${task.id} is resumed; queued work starts when a worker slot is free.`,
    ]);
  });

  it('does nothing when the task is already in the asked state', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Intake' });

    await app.resumeTask.execute({ taskId: task.id });
    await app.setTaskModel.execute({ taskId: task.id, model: 'opus' });
    await app.setTaskModel.execute({ taskId: task.id, model: 'opus' });

    expect(app.messagesOf(thread.id).filter((m) => m.kind === 'system')).toHaveLength(1);
    expect(app.task(task.id).model).toBe('opus');
  });

  it('refuses to hold or switch a finished task', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Intake' });
    await app.cancelTask.execute({ taskId: task.id });

    await expect(app.holdTask.execute({ taskId: task.id })).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    await expect(
      app.setTaskModel.execute({ taskId: task.id, model: 'fable' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
  });
});

describe('SendNow', () => {
  it("hands a message waiting for the task's worker to the dispatcher", async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Intake' });
    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'hold on' });
    const message = app.messagesOf(thread.id).find((m) => m.kind === 'owner');
    expect(message).toMatchObject({ taskId: task.id, body: { delivery: 'queued' } });
    app.clearEffects();

    await app.sendNow.execute(message!.id);

    expect(app.messagesOf(thread.id).find((m) => m.id === message!.id)).toMatchObject({
      taskId: null,
      body: { delivery: 'queued' },
    });
    expect(app.runs.calls).toEqual([{ type: 'dispatcher_turn', threadId: thread.id }]);
    expect(await app.uow.run((tx) => tx.messages.queuedWorkerInput(task.id))).toEqual([]);
    expect(
      (await app.uow.run((tx) => tx.messages.queuedDispatcherInput(thread.id))).map((m) => m.id),
    ).toEqual([message!.id]);
  });

  it('refuses a message that is not waiting for a worker', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'hello' });
    const message = app.messagesOf(thread.id).find((m) => m.kind === 'owner');

    await expect(app.sendNow.execute(message!.id)).rejects.toThrow(/still waits/);
  });
});
