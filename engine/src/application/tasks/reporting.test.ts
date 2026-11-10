import { describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidInputError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

const PR = { number: 7, url: 'https://github.com/o/r/pull/7' };

describe('ReportStage', () => {
  it('moves between Implementing and Reviewing and journals each move', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    const identity = app.identity.worker(task);

    await app.reportStage.execute(identity, { stage: 'Reviewing', note: 'code done' });
    await app.reportStage.execute(identity, { stage: 'Implementing' });
    await app.reportStage.execute(identity, { stage: 'Reviewing' });

    expect(app.task(task.id).stage).toBe('Reviewing');
    const moves = app.db.tables.journal.filter((e) => e.type === 'stage_changed').slice(-3);
    expect(moves.map((e) => e.data.to)).toEqual(['Reviewing', 'Implementing', 'Reviewing']);
    expect(
      app.db.tables.journal.some((e) => e.type === 'stage_note' && e.data.note === 'code done'),
    ).toBe(true);
  });

  it('repeating the current stage only adds a note', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    const before = app.db.tables.journal.filter((e) => e.type === 'stage_changed').length;

    await app.reportStage.execute(app.identity.worker(task), {
      stage: 'Implementing',
      note: '3/5',
    });

    expect(app.db.tables.journal.filter((e) => e.type === 'stage_changed')).toHaveLength(before);
    expect(app.db.tables.journal.at(-1)).toMatchObject({ type: 'stage_note' });
  });

  it('posts a visible chat line when a note is given for the current (unchanged) stage', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Implementing' });

    await app.reportStage.execute(app.identity.worker(task), {
      stage: 'Implementing',
      note: 'ran the suite, fixing 2 failures',
    });

    const posted = app.messagesOf(thread.id).find((m) => m.kind === 'jarvis');
    expect(posted).toMatchObject({ body: { text: 'ran the suite, fixing 2 failures' } });
  });

  it('does not post a chat line for a plain stage move with no note', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Implementing' });

    await app.reportStage.execute(app.identity.worker(task), { stage: 'Reviewing' });

    expect(app.messagesOf(thread.id).some((m) => m.kind === 'jarvis')).toBe(false);
  });

  it('rejects a move the stage table does not allow', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Context' });

    await expect(
      app.reportStage.execute(app.identity.worker(task), { stage: 'Reviewing' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
  });

  // ADR-0022: the engine sets these two when it runs `open_pr`; a worker cannot report them, even
  // if a caller got past the tool's schema.
  it.each(['Verifying', 'PR Open'])(
    'refuses %s from a worker and changes nothing',
    async (stage) => {
      const app = buildTestApp();
      const { task } = await app.seed.task({ stage: 'Implementing' });
      const journal = app.db.tables.journal.length;

      await expect(
        app.reportStage.execute(app.identity.worker(task), { stage: stage as 'Reviewing' }),
      ).rejects.toBeInstanceOf(InvalidInputError);

      expect(app.task(task.id).stage).toBe('Implementing');
      expect(app.db.tables.journal).toHaveLength(journal);
    },
  );

  // A ui_check task never opens a pull request, so the watcher's `PR Open -> Done` never reaches
  // it. Without `Done` here it had no way at all to finish and sat in Reviewing for good — which
  // is where T-4 on quick-blog PR #38 stayed after a passing check (ADR-0018).
  it('lets a ui_check task close itself from Reviewing', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Reviewing', kind: 'ui_check', pr: PR });

    await app.reportStage.execute(app.identity.worker(task), {
      stage: 'Done',
      note: 'verdict: pass',
    });

    expect(app.task(task.id).stage).toBe('Done');
  });

  it('refuses Done for a build task, whose pull request closes it instead', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Reviewing' });

    await expect(
      app.reportStage.execute(app.identity.worker(task), { stage: 'Done' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    expect(app.task(task.id).stage).toBe('Reviewing');
  });
});

describe('worker tools after the task ended', () => {
  it('are all refused once the task is cancelled', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Verifying' });
    const identity = app.identity.worker(task);
    await app.cancelTask.execute({ taskId: task.id });
    app.clearEffects();

    const calls = [
      app.reportStage.execute(identity, { stage: 'Reviewing' }),
      app.openPr.execute(identity, { title: 't', body: 'b' }),
      app.askOwner.execute(identity, { question: 'q?' }),
    ];

    for (const call of calls) await expect(call).rejects.toBeInstanceOf(ForbiddenError);
    expect(app.task(task.id).stage).toBe('Cancelled');
    expect(app.owner.delivered).toEqual([]);
  });
});
