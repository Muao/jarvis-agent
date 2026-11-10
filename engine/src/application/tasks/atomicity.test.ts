import { describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../testing/build-test-app.js';

/** A use case that changes a task: `arrange` seeds state, the returned function is the call under test. */
interface Case {
  readonly name: string;
  readonly arrange: (app: TestApp) => Promise<() => Promise<unknown>>;
}

async function specCard(app: TestApp) {
  const { task } = await app.seed.task({ stage: 'Context' });
  app.artifacts.write(task.id, 'spec.md', 's');
  app.artifacts.write(task.id, 'plan.md', 'p');
  const { cardId } = await app.submitSpec.execute(app.identity.worker(task), { summary: 's' });
  return { task, cardId };
}

const CASES: readonly Case[] = [
  {
    name: 'CreateTask',
    arrange: async (app) => {
      const thread = await app.seed.thread();
      return () =>
        app.createTask.execute(app.identity.dispatcher(thread.id), {
          title: 't',
          description: 'd',
        });
    },
  },
  {
    name: 'SubmitSpec',
    arrange: async (app) => {
      const { task } = await app.seed.task({ stage: 'Context' });
      app.artifacts.write(task.id, 'spec.md', 's');
      app.artifacts.write(task.id, 'plan.md', 'p');
      return () => app.submitSpec.execute(app.identity.worker(task), { summary: 's' });
    },
  },
  {
    name: 'AnswerDecision (approve)',
    arrange: async (app) => {
      const { cardId } = await specCard(app);
      return () => app.answerDecision.execute(cardId, { decision: 'approve' });
    },
  },
  {
    name: 'AnswerDecision (request changes)',
    arrange: async (app) => {
      const { cardId } = await specCard(app);
      return () =>
        app.answerDecision.execute(cardId, { decision: 'request_changes', comment: 'x' });
    },
  },
  {
    name: 'AskOwner',
    arrange: async (app) => {
      const { task } = await app.seed.task({ stage: 'Implementing' });
      return () => app.askOwner.execute(app.identity.worker(task), { question: 'q?' });
    },
  },
  {
    name: 'AnswerQuestion',
    arrange: async (app) => {
      const { task } = await app.seed.task({ stage: 'Implementing' });
      const { cardId } = await app.askOwner.execute(app.identity.worker(task), { question: 'q?' });
      return () => app.answerQuestion.execute(cardId, 'a');
    },
  },
  {
    name: 'ReportStage',
    arrange: async (app) => {
      const { task } = await app.seed.task({ stage: 'Implementing' });
      return () => app.reportStage.execute(app.identity.worker(task), { stage: 'Reviewing' });
    },
  },
  {
    name: 'OpenPr (red gate)',
    arrange: async (app) => {
      const { task } = await app.seed.task({ stage: 'Reviewing' });
      app.checkRunner.script('pnpm test', { exitCode: 1 });
      return () => app.openPr.execute(app.identity.worker(task), { title: 't', body: 'b' });
    },
  },
  {
    name: 'OpenPr (green gate, PR opened)',
    arrange: async (app) => {
      const { task } = await app.seed.task({ stage: 'Reviewing' });
      return () => app.openPr.execute(app.identity.worker(task), { title: 't', body: 'b' });
    },
  },
  {
    name: 'CancelTask',
    arrange: async (app) => {
      const { task } = await app.seed.task({ stage: 'Implementing' });
      return () => app.cancelTask.execute({ taskId: task.id });
    },
  },
  {
    name: 'RetryStage (Failed)',
    arrange: async (app) => {
      const { task } = await app.seed.task({ stage: 'Verifying' });
      app.checkRunner.script('pnpm test', { exitCode: 1 });
      for (let i = 0; i < 4; i++) {
        await app.openPr.execute(app.identity.worker(task), { title: 't', body: 'b' });
      }
      return () => app.retryStage.execute(task.id);
    },
  },
];

const effectsOf = (app: TestApp) => ({
  delivered: [...app.owner.delivered],
  updates: [...app.owner.updates],
  events: [...app.events.published],
  runs: [...app.runs.calls],
});

describe('journal and state change share one transaction (ADR-0008)', () => {
  it.each(CASES)('$name appends a journal row when it succeeds', async ({ arrange }) => {
    const app = buildTestApp();
    const act = await arrange(app);
    const before = app.db.tables.journal.length;

    await act();

    expect(app.db.tables.journal.length).toBeGreaterThan(before);
  });

  it.each(CASES)(
    '$name: a failing journal write rolls everything back and notifies nobody',
    async ({ arrange }) => {
      const app = buildTestApp();
      const act = await arrange(app);
      const tablesBefore = app.db.snapshot();
      app.clearEffects();
      vi.spyOn(app.uow.repositories.journal, 'append').mockRejectedValue(
        new Error('journal unavailable'),
      );

      await expect(act()).rejects.toThrow('journal unavailable');

      expect(app.db.tables).toEqual(tablesBefore);
      expect(effectsOf(app)).toEqual({ delivered: [], updates: [], events: [], runs: [] });
    },
  );
});
