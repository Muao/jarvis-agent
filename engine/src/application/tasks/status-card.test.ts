import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../testing/build-test-app.js';

const stepStates = (body: Record<string, unknown>): string =>
  (body.steps as { label: string; state: string }[]).map((s) => `${s.label}:${s.state}`).join(' ');

describe('status card (SLK-07)', () => {
  it('is one message per task, updated in place through the whole lifecycle', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    const { taskId } = await app.createTask.execute(app.identity.dispatcher(thread.id), {
      title: 't',
      description: 'd',
    });
    const task = app.task(taskId);
    const worker = app.identity.worker(task);
    const cardOf = () => app.messagesOf(thread.id).filter((m) => m.kind === 'status');
    const [card] = cardOf();
    expect(card).toBeDefined();

    await app.uow.run(async (tx) => {
      await tx.tasks.save({ ...task, stage: 'Context' });
    });
    app.artifacts.write(taskId, 'spec.md', 's');
    app.artifacts.write(taskId, 'plan.md', 'p');
    const { cardId } = await app.submitSpec.execute(worker, { summary: 's' });
    await app.answerDecision.execute(cardId, { decision: 'approve' });
    // The gate is red once (one retry used), then green: the engine opens the PR (ADR-0022).
    app.checkRunner.script('pnpm test', { exitCode: 1 });
    await app.openPr.execute(worker, { title: 't', body: 'b' });
    app.checkRunner.script('pnpm test', { exitCode: 0 });
    await app.openPr.execute(worker, { title: 't', body: 'b' });

    expect(cardOf()).toHaveLength(1);
    expect(cardOf()[0]?.id).toBe(card?.id);
    expect(cardOf()[0]?.body).toMatchObject({
      taskId,
      stage: 'PR Open',
      checks: { used: 0, max: 3 },
      ciFixes: { used: 0, max: 2 },
      reviews: { used: 0, max: 3 },
    });
    // created once, then only updated
    expect(app.owner.delivered.filter((m) => m.id === card?.id)).toHaveLength(1);
    expect(app.owner.updates.filter((m) => m.id === card?.id).length).toBeGreaterThan(3);
  });

  it('carries the start time and, once a run began, the worker session', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    const cardOf = () => app.uow.run((tx) => tx.messages.statusCardOf(task.id));
    expect((await cardOf())?.body).toMatchObject({
      workerSessionId: null,
      startedAt: task.startedAt,
    });

    const withSession = { ...task, workerSessionId: 'ses-1' };
    await app.uow.run((tx) => tx.tasks.save(withSession));
    await app.reportStage.execute(app.identity.worker(withSession), { stage: 'Reviewing' });

    expect((await cardOf())?.body).toMatchObject({
      workerSessionId: 'ses-1',
      startedAt: task.startedAt,
    });
  });

  it('shows done / active / pending steps for the stage', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    const card = await app.uow.run((tx) => tx.messages.statusCardOf(task.id));

    expect(stepStates(card?.body ?? {})).toBe(
      'context:done spec:done implementing:active verifying:pending reviewing:pending pr:pending',
    );
  });

  it('goes back a step when the owner requests changes', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Context' });
    app.artifacts.write(task.id, 'spec.md', 's');
    app.artifacts.write(task.id, 'plan.md', 'p');
    const { cardId } = await app.submitSpec.execute(app.identity.worker(task), { summary: 's' });
    app.clearEffects();

    await app.answerDecision.execute(cardId, { decision: 'request_changes', comment: 'redo' });

    const card = await app.uow.run((tx) => tx.messages.statusCardOf(task.id));
    expect(stepStates(card?.body ?? {})).toMatch(/^context:active spec:pending/);
  });

  it('keeps the step a blocked task will return to marked active', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Verifying' });

    await app.askOwner.execute(app.identity.worker(task), { question: 'q?' });

    const card = await app.uow.run((tx) => tx.messages.statusCardOf(task.id));
    expect(card?.body).toMatchObject({ stage: 'Blocked' });
    expect(stepStates(card?.body ?? {})).toContain('verifying:active');
  });

  it('freezes the progress of a cancelled task with nothing active', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await app.cancelTask.execute({ taskId: task.id });

    const card = await app.uow.run((tx) => tx.messages.statusCardOf(task.id));
    expect(card?.body).toMatchObject({ stage: 'Cancelled' });
    expect(stepStates(card?.body ?? {})).toBe(
      'context:done spec:done implementing:pending verifying:pending reviewing:pending pr:pending',
    );
  });

  it('takes its limits from the current config', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Verifying' });
    app.config.set({
      ...app.config.current(),
      limits: { ...app.config.current().limits, checkRetries: 5 },
    });

    app.checkRunner.script('pnpm test', { exitCode: 1 });
    await app.openPr.execute(app.identity.worker(task), { title: 't', body: 'b' });

    const card = await app.uow.run((tx) => tx.messages.statusCardOf(task.id));
    expect(card?.body).toMatchObject({ checks: { used: 1, max: 5 } });
  });
});
