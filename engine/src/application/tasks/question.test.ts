import { describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('AskOwner', () => {
  it('blocks the task with the question as reason and posts one question card', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Implementing' });

    const { cardId } = await app.askOwner.execute(app.identity.worker(task), {
      question: 'Which database?',
      options: ['Postgres', 'SQLite'],
    });

    expect(app.task(task.id)).toMatchObject({
      stage: 'Blocked',
      resumeStage: 'Implementing',
      reason: 'Which database?',
    });
    expect(app.message(cardId)).toMatchObject({
      kind: 'question',
      threadId: thread.id,
      body: { taskId: task.id, question: 'Which database?', options: ['Postgres', 'SQLite'] },
    });
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      data: { from: 'Implementing', to: 'Blocked', cause: 'ask_owner' },
    });
  });

  it('allows a free-text question (no options)', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Context' });

    const { cardId } = await app.askOwner.execute(app.identity.worker(task), { question: 'Why?' });

    expect(app.message(cardId).body).toMatchObject({ options: [] });
  });

  it('cannot ask a second question while blocked', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    await app.askOwner.execute(app.identity.worker(task), { question: 'one?' });

    await expect(
      app.askOwner.execute(app.identity.worker(task), { question: 'two?' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    expect(app.messagesOf(task.threadId).filter((m) => m.kind === 'question')).toHaveLength(1);
  });

  it('is refused for a run of another role or of a finished task', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Implementing' });

    await expect(
      app.askOwner.execute(app.identity.dispatcher(thread.id), { question: 'q?' }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await app.cancelTask.execute({ taskId: task.id });
    await expect(
      app.askOwner.execute(app.identity.worker(task), { question: 'q?' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('is refused for an unknown task id in the identity', async () => {
    const app = buildTestApp();

    await expect(
      app.askOwner.execute(
        { runId: 'r', role: 'worker', threadId: 'th-1', taskId: 'T-9' },
        { question: 'q?' },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('AnswerQuestion', () => {
  async function blocked(stage: 'Context' | 'Implementing' | 'PR Open' = 'Implementing') {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage });
    const { cardId } = await app.askOwner.execute(app.identity.worker(seeded.task), {
      question: 'Which database?',
    });
    app.clearEffects();
    return { app, ...seeded, cardId };
  }

  it('returns the task to the stage it asked from, queues the answer and resumes the worker', async () => {
    const { app, task, cardId } = await blocked('Context');

    await app.answerQuestion.execute(cardId, 'Postgres');

    expect(app.task(task.id)).toMatchObject({ stage: 'Context', resumeStage: null, reason: null });
    expect(app.message(cardId).answer).toEqual({ text: 'Postgres' });
    const queued = await app.uow.run((tx) => tx.messages.queuedWorkerInput(task.id));
    expect(queued.map((m) => m.body.text)).toEqual(['Postgres']);
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'resume' }]);
    expect(app.db.tables.journal.filter((e) => e.type === 'stage_changed').at(-1)).toMatchObject({
      actor: 'owner',
      data: { from: 'Blocked', to: 'Context', cause: 'owner_answered' },
    });
  });

  it('answers a question asked from PR Open back in PR Open; a push from there moves it on', async () => {
    const { app, task, cardId } = await blocked('PR Open');

    await app.answerQuestion.execute(cardId, 'Push it');

    expect(app.task(task.id)).toMatchObject({ stage: 'PR Open', resumeStage: null });
    const moves = app.db.tables.journal.filter((e) => e.type === 'stage_changed').slice(-1);
    expect(moves.map((e) => e.data)).toMatchObject([
      { from: 'Blocked', to: 'PR Open', cause: 'owner_answered' },
    ]);
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'resume' }]);
  });

  it('takes one answer only', async () => {
    const { app, task, cardId } = await blocked();
    await app.answerQuestion.execute(cardId, 'Postgres');
    app.clearEffects();

    await expect(app.answerQuestion.execute(cardId, 'SQLite')).rejects.toMatchObject({
      code: 'already_answered',
    });

    expect(app.message(cardId).answer).toEqual({ text: 'Postgres' });
    expect(app.runs.calls).toEqual([]);
    const queued = await app.uow.run((tx) => tx.messages.queuedWorkerInput(task.id));
    expect(queued).toHaveLength(1);
  });

  it('refuses an answer after the task was cancelled, storing nothing', async () => {
    const { app, task, cardId } = await blocked();
    await app.cancelTask.execute({ taskId: task.id });
    app.clearEffects();
    const messagesBefore = app.db.tables.messages.size;

    await expect(app.answerQuestion.execute(cardId, 'Postgres')).rejects.toMatchObject({
      code: 'task_cancelled',
    });

    expect(app.db.tables.messages.size).toBe(messagesBefore);
    expect(app.message(cardId).answeredAt).toBeNull();
    expect(app.runs.calls).toEqual([]);
    expect(app.owner.delivered).toEqual([]);
  });

  it('rejects a decision card and an unknown card', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Context' });
    app.artifacts.write(task.id, 'spec.md', 's');
    app.artifacts.write(task.id, 'plan.md', 'p');
    const { cardId } = await app.submitSpec.execute(app.identity.worker(task), { summary: 's' });

    await expect(app.answerQuestion.execute(cardId, 'x')).rejects.toMatchObject({
      code: 'not_a_card',
    });
    await expect(app.answerQuestion.execute('m-404', 'x')).rejects.toBeInstanceOf(NotFoundError);
  });
});
