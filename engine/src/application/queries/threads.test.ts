import { ThreadDetailDtoSchema, ThreadDtoSchema } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NotFoundError } from '../errors.js';
import { buildTestApp, createTaskInNewThread } from '../testing/index.js';

describe('GetThreads / GetThread', () => {
  it('lists threads waiting for the owner first, then by last activity, in the shared shape', async () => {
    const app = buildTestApp({ realRuns: true });
    const quiet = await app.seed.thread('Quiet');
    app.clock.advanceMinutes(1);
    const { thread: working, taskId } = await createTaskInNewThread(app);
    app.clock.advanceMinutes(1);
    const newest = await app.seed.thread('Newest');
    app.clock.advanceMinutes(1);
    const token = app.runner.forTask(taskId)?.spec.runToken ?? '';
    await app.askOwner.execute(app.resolveRunIdentity.execute(token), {
      question: 'Which database?',
      options: ['postgres', 'sqlite'],
    });

    const threads = z.array(ThreadDtoSchema).parse(await app.getThreads.execute());

    expect(threads.map((t) => t.id)).toEqual([working.id, newest.id, quiet.id]);
    expect(threads[0]).toMatchObject({
      taskId,
      stage: 'Blocked',
      waitingForOwner: true,
      prNumber: null,
      prUrl: null,
    });
    expect(threads[1]).toMatchObject({ taskId: null, stage: null, waitingForOwner: false });
  });

  it("flags a thread and its task as working while the task's worker runs", async () => {
    const app = buildTestApp({ realRuns: true });
    const { thread, taskId } = await createTaskInNewThread(app);

    expect((await app.getThreads.execute())[0]).toMatchObject({ taskId, working: true });
    expect(await app.getThread.execute(thread.id)).toMatchObject({ working: true });
    expect((await app.getTasks.execute())[0]).toMatchObject({ id: taskId, working: true });

    await app.cancelTask.execute({ taskId });
    expect((await app.getThreads.execute())[0]).toMatchObject({ taskId, working: false });
    expect((await app.getTasks.execute())[0]).toMatchObject({ id: taskId, working: false });
  });

  it('stops waiting once the card is answered, and shows a finished task on its thread', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app);
    const token = app.runner.forTask(taskId)?.spec.runToken ?? '';
    const { cardId } = await app.askOwner.execute(app.resolveRunIdentity.execute(token), {
      question: 'Which database?',
    });
    expect((await app.getThreads.execute())[0]?.waitingForOwner).toBe(true);

    await app.answerQuestion.execute(cardId, 'postgres');
    expect((await app.getThreads.execute())[0]).toMatchObject({
      waitingForOwner: false,
      stage: 'Context',
    });

    await app.cancelTask.execute({ taskId });
    expect(ThreadDtoSchema.parse((await app.getThreads.execute())[0])).toMatchObject({
      taskId,
      stage: 'Cancelled',
      waitingForOwner: false,
    });
  });

  it('returns a thread with its messages, the dispatcher session and the busy flag', async () => {
    const app = buildTestApp({ realRuns: true });
    const thread = await app.seed.thread('Ask about Notion');
    expect(ThreadDetailDtoSchema.parse(await app.getThread.execute(thread.id))).toMatchObject({
      dispatcherSessionId: null,
      dispatcherBusy: false,
      activeRun: null,
      messages: [],
    });

    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'What does Notion say?' });
    app.clock.advanceMinutes(1);
    await app.runner.forThread(thread.id, 'dispatcher')?.emit({
      kind: 'text',
      payload: { text: 'Looking it up' },
    });

    const detail = ThreadDetailDtoSchema.parse(await app.getThread.execute(thread.id));
    expect(detail).toMatchObject({ id: thread.id, dispatcherBusy: true, taskId: null });
    expect(detail.dispatcherSessionId).toMatch(/^s-/);
    expect(detail.activeRun).toMatchObject({
      role: 'dispatcher',
      taskId: null,
      note: 'Looking it up',
      tool: null,
    });
    expect(detail.messages).toMatchObject([
      {
        kind: 'owner',
        body: { text: 'What does Notion say?', delivery: 'delivered', source: 'owner' },
      },
    ]);
  });

  it('lists every message of a task thread in order, cards with their answers', async () => {
    const app = buildTestApp({ realRuns: true });
    const { thread, taskId } = await createTaskInNewThread(app);
    const token = app.runner.forTask(taskId)?.spec.runToken ?? '';
    const { cardId } = await app.askOwner.execute(app.resolveRunIdentity.execute(token), {
      question: 'Which database?',
      options: ['postgres'],
    });
    app.clock.advanceMinutes(2);
    await app.answerQuestion.execute(cardId, 'postgres');

    const detail = ThreadDetailDtoSchema.parse(await app.getThread.execute(thread.id));

    expect(detail.messages.map((m) => m.kind)).toContain('status');
    const card = detail.messages.find((m) => m.kind === 'question');
    expect(card).toMatchObject({
      answer: { text: 'postgres' },
      body: { question: 'Which database?', options: ['postgres'] },
    });
    expect(card?.answeredAt).not.toBeNull();
    expect(detail).toMatchObject({ taskId, stage: 'Context', waitingForOwner: false });
  });

  it('rejects an unknown thread', async () => {
    const app = buildTestApp();
    await expect(app.getThread.execute('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
