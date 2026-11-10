import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('PostOwnerMessage', () => {
  it('opens a thread for a first message and asks the dispatcher for a turn', async () => {
    const app = buildTestApp();

    const posted = await app.postOwnerMessage.execute({ text: 'Add a health endpoint\nplease' });

    expect(posted.route).toBe('dispatcher');
    expect(app.db.tables.threads.get(posted.threadId)?.title).toBe('Add a health endpoint');
    expect(app.message(posted.messageId)).toMatchObject({
      kind: 'owner',
      threadId: posted.threadId,
      taskId: null,
      body: { text: 'Add a health endpoint\nplease', delivery: 'queued' },
    });
    expect(app.runs.calls).toEqual([{ type: 'dispatcher_turn', threadId: posted.threadId }]);
    expect(app.owner.delivered.map((m) => m.id)).toEqual([posted.messageId]);
    expect(app.events.published).toContainEqual({ type: 'thread', id: posted.threadId });
  });

  it('continues an existing thread without a task via the dispatcher', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    const posted = await app.postOwnerMessage.execute({ threadId: thread.id, text: 'status?' });

    expect(posted).toMatchObject({ threadId: thread.id, route: 'dispatcher' });
    expect(app.runs.calls).toEqual([{ type: 'dispatcher_turn', threadId: thread.id }]);
  });

  it('queues behind a running dispatcher turn without asking for another', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    app.db.tables.runs.set('r-1', {
      id: 'r-1',
      sessionId: 's-1',
      role: 'dispatcher',
      threadId: thread.id,
      taskId: null,
      status: 'running',
      startedAt: app.clock.now(),
      finishedAt: null,
      costUsd: 0,
      turns: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: null,
      modelUsage: {},
      exitCode: null,
      error: null,
    });

    const posted = await app.postOwnerMessage.execute({ threadId: thread.id, text: 'and also' });

    expect(posted.route).toBe('dispatcher_queued');
    expect(app.message(posted.messageId).body).toMatchObject({ delivery: 'queued' });
    expect(app.runs.calls).toEqual([]);
  });

  it('routes to the worker of an active task and journals the input', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Implementing' });

    const posted = await app.postOwnerMessage.execute({ threadId: thread.id, text: 'use fetch' });

    expect(posted.route).toBe('worker_input');
    expect(app.message(posted.messageId)).toMatchObject({ taskId: task.id });
    expect(app.runs.calls).toEqual([{ type: 'deliver_to_worker', taskId: task.id }]);
    expect(app.db.tables.journal.map((e) => e.type)).toContain('owner_input');
  });

  it('moves a build task in PR Open to Fixing without using a fix round', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({
      stage: 'PR Open',
      pr: { number: 7, url: 'https://example.test/o/r/pull/7' },
    });

    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'push the visual fixes' });

    const after = app.task(task.id);
    expect(after.stage).toBe('Fixing');
    expect(after.counters).toEqual(task.counters);
    expect(app.db.tables.journal).toContainEqual(
      expect.objectContaining({
        type: 'stage_changed',
        actor: 'owner',
        data: expect.objectContaining({ from: 'PR Open', to: 'Fixing', cause: 'owner_request' }),
      }),
    );
    expect(app.runs.calls).toEqual([{ type: 'deliver_to_worker', taskId: task.id }]);
  });

  it('leaves a ui_check task alone', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Reviewing', kind: 'ui_check' });

    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'recheck' });

    expect(app.task(task.id).stage).toBe('Reviewing');
  });

  it('goes back to the dispatcher once the thread task is finished', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Implementing' });
    await app.cancelTask.execute({ taskId: task.id });
    app.clearEffects();

    const posted = await app.postOwnerMessage.execute({ threadId: thread.id, text: 'new idea' });

    expect(posted.route).toBe('dispatcher');
    expect(app.runs.calls).toEqual([{ type: 'dispatcher_turn', threadId: thread.id }]);
  });

  it('treats a text reply to an open question card as the answer', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Implementing' });
    const { cardId } = await app.askOwner.execute(app.identity.worker(task), {
      question: 'Which db?',
    });
    app.clearEffects();

    const posted = await app.postOwnerMessage.execute({ threadId: thread.id, text: 'Postgres' });

    expect(posted.route).toBe('worker_input');
    expect(app.message(cardId)).toMatchObject({ answer: { text: 'Postgres' } });
    expect(app.task(task.id).stage).toBe('Implementing');
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'resume' }]);
    // the reply itself is the queued input; no second message is created for it
    expect(app.messagesOf(thread.id).filter((m) => m.kind === 'owner')).toHaveLength(1);
  });

  it('treats free text while the spec awaits approval as "request changes" (WRK-04)', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Context' });
    app.artifacts.write(task.id, 'spec.md', 's');
    app.artifacts.write(task.id, 'plan.md', 'p');
    const { cardId } = await app.submitSpec.execute(app.identity.worker(task), { summary: 's' });
    app.clearEffects();

    const posted = await app.postOwnerMessage.execute({
      threadId: thread.id,
      text: 'Cover the 503 case',
    });

    expect(app.task(task.id).stage).toBe('Context');
    expect(app.message(cardId).answer).toEqual({
      decision: 'request_changes',
      comment: 'Cover the 503 case',
    });
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'resume' }]);
    const owner = app.messagesOf(thread.id).filter((m) => m.kind === 'owner');
    expect(owner.map((m) => m.id)).toEqual([posted.messageId]);
  });

  it('rejects an unknown thread and stores nothing', async () => {
    const app = buildTestApp();

    await expect(
      app.postOwnerMessage.execute({ threadId: 'nope', text: 'hi' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(app.db.tables.messages.size).toBe(0);
    expect(app.runs.calls).toEqual([]);
    expect(app.owner.delivered).toEqual([]);
  });
});
