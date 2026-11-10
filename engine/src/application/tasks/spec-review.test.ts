import { describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../errors.js';
import { buildTestApp, type TestApp } from '../testing/build-test-app.js';

async function taskInSpecReview(app: TestApp) {
  const seeded = await app.seed.task({ stage: 'Context' });
  app.artifacts.write(seeded.task.id, 'spec.md', '# spec');
  app.artifacts.write(seeded.task.id, 'plan.md', '# plan');
  const { cardId } = await app.submitSpec.execute(app.identity.worker(seeded.task), {
    summary: 'Add /health',
  });
  app.clearEffects();
  return { ...seeded, cardId };
}

describe('SubmitSpec', () => {
  it('moves Context to Spec Review and posts a decision card linking spec.md and plan.md', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Context' });
    app.artifacts.write(task.id, 'spec.md', '# spec');
    app.artifacts.write(task.id, 'plan.md', '# plan');

    const { cardId } = await app.submitSpec.execute(app.identity.worker(task), {
      summary: 'Add /health',
    });

    expect(app.task(task.id).stage).toBe('Spec Review');
    expect(app.message(cardId)).toMatchObject({
      kind: 'decision',
      threadId: thread.id,
      taskId: task.id,
      answeredAt: null,
      body: {
        taskId: task.id,
        summary: expect.stringContaining('Add /health') as unknown,
        artifacts: ['spec.md', 'plan.md'],
        checks: ['pnpm test', 'pnpm typecheck'],
        checksSource: 'agents_md',
      },
    });
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      type: 'stage_changed',
      data: { from: 'Context', to: 'Spec Review', cause: 'spec_submitted' },
    });
    expect(app.owner.delivered.map((m) => m.id)).toContain(cardId);
  });

  it('needs spec.md and plan.md to exist', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Context' });
    app.artifacts.write(task.id, 'spec.md', '# spec');

    await expect(
      app.submitSpec.execute(app.identity.worker(task), { summary: 's' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(app.task(task.id).stage).toBe('Context');
  });

  it('is refused from a stage that cannot move to Spec Review', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    app.artifacts.write(task.id, 'spec.md', '# spec');
    app.artifacts.write(task.id, 'plan.md', '# plan');

    await expect(
      app.submitSpec.execute(app.identity.worker(task), { summary: 's' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
  });

  it('is refused for a run whose task was cancelled', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Context' });
    await app.cancelTask.execute({ taskId: task.id });

    await expect(
      app.submitSpec.execute(app.identity.worker(task), { summary: 's' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('AnswerDecision', () => {
  it('approve: Spec Review -> Implementing, card answered, worker resumed', async () => {
    const app = buildTestApp();
    const { task, cardId } = await taskInSpecReview(app);

    await app.answerDecision.execute(cardId, { decision: 'approve' });

    expect(app.task(task.id).stage).toBe('Implementing');
    expect(app.message(cardId)).toMatchObject({
      answer: { decision: 'approve' },
      answeredAt: app.clock.now(),
    });
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'resume' }]);
    expect(app.owner.updates.map((m) => m.id)).toContain(cardId);
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      actor: 'owner',
      data: { from: 'Spec Review', to: 'Implementing', cause: 'spec_approved' },
    });
  });

  it('request changes: back to Context, the comment becomes queued worker input, worker resumed', async () => {
    const app = buildTestApp();
    const { task, cardId } = await taskInSpecReview(app);

    await app.answerDecision.execute(cardId, {
      decision: 'request_changes',
      comment: 'Cover the 503 case',
    });

    expect(app.task(task.id).stage).toBe('Context');
    expect(app.message(cardId).answer).toEqual({
      decision: 'request_changes',
      comment: 'Cover the 503 case',
    });
    const queued = await app.uow.run((tx) => tx.messages.queuedWorkerInput(task.id));
    expect(queued.map((m) => m.body.text)).toEqual(['Cover the 503 case']);
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'resume' }]);
  });

  it('request changes needs a comment', async () => {
    const app = buildTestApp();
    const { task, cardId } = await taskInSpecReview(app);

    await expect(
      app.answerDecision.execute(cardId, { decision: 'request_changes', comment: '  ' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(app.task(task.id).stage).toBe('Spec Review');
    expect(app.message(cardId).answeredAt).toBeNull();
  });

  it('takes one answer only (SLK-06)', async () => {
    const app = buildTestApp();
    const { task, cardId } = await taskInSpecReview(app);
    await app.answerDecision.execute(cardId, { decision: 'approve' });
    app.clearEffects();
    const journalBefore = app.db.tables.journal.length;

    await expect(
      app.answerDecision.execute(cardId, { decision: 'request_changes', comment: 'no' }),
    ).rejects.toMatchObject({ code: 'already_answered' });

    expect(app.message(cardId).answer).toEqual({ decision: 'approve' });
    expect(app.task(task.id).stage).toBe('Implementing');
    expect(app.db.tables.journal).toHaveLength(journalBefore);
    expect(app.runs.calls).toEqual([]);
    expect(app.owner.updates).toEqual([]);
  });

  it('refuses an answer after the task was cancelled', async () => {
    const app = buildTestApp();
    const { task, cardId } = await taskInSpecReview(app);
    await app.cancelTask.execute({ taskId: task.id });
    app.clearEffects();

    await expect(app.answerDecision.execute(cardId, { decision: 'approve' })).rejects.toMatchObject(
      {
        code: 'task_cancelled',
      },
    );

    expect(app.task(task.id).stage).toBe('Cancelled');
    expect(app.message(cardId).answeredAt).toBeNull();
    expect(app.runs.calls).toEqual([]);
  });

  it('rejects a card that is not a decision card and an unknown card', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    const { cardId } = await app.askOwner.execute(app.identity.worker(task), { question: 'q?' });

    await expect(app.answerDecision.execute(cardId, { decision: 'approve' })).rejects.toMatchObject(
      {
        code: 'not_a_card',
      },
    );
    await expect(
      app.answerDecision.execute('m-404', { decision: 'approve' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
