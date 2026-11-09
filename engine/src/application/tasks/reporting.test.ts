import { describe, expect, it } from 'vitest';
import { newWatch } from '../code-host/new-watch.js';
import { ForbiddenError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

const PR = { number: 7, url: 'https://github.com/o/r/pull/7' };

describe('ReportStage', () => {
  it('moves between Implementing, Verifying and Reviewing and journals each move', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    const identity = app.identity.worker(task);

    await app.reportStage.execute(identity, { stage: 'Verifying', note: 'code done' });
    await app.reportStage.execute(identity, { stage: 'Reviewing' });

    expect(app.task(task.id).stage).toBe('Reviewing');
    const moves = app.db.tables.journal.filter((e) => e.type === 'stage_changed').slice(-2);
    expect(moves.map((e) => e.data.to)).toEqual(['Verifying', 'Reviewing']);
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

    await app.reportStage.execute(app.identity.worker(task), { stage: 'Verifying' });

    expect(app.messagesOf(thread.id).some((m) => m.kind === 'jarvis')).toBe(false);
  });

  it('rejects a move the stage table does not allow', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Context' });

    await expect(
      app.reportStage.execute(app.identity.worker(task), { stage: 'Verifying' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
  });

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

describe('ReportChecks', () => {
  it('passed: journals and leaves the task alone', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Verifying' });

    const result = await app.reportChecks.execute(app.identity.worker(task), {
      passed: true,
      summary: 'lint, typecheck, tests green',
    });

    expect(result).toEqual({ outcome: 'passed' });
    expect(app.task(task.id).counters.checkRetries).toBe(0);
    expect(app.db.tables.journal.at(-1)).toMatchObject({ type: 'checks_passed' });
  });

  it('failed: counts the attempt, journals it and updates the status counters in place', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Verifying' });

    const result = await app.reportChecks.execute(app.identity.worker(task), {
      passed: false,
      summary: '2 tests red',
    });

    expect(result).toEqual({ outcome: 'retry', attempt: 1, max: 3 });
    expect(app.task(task.id)).toMatchObject({ stage: 'Verifying', counters: { checkRetries: 1 } });
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      type: 'checks_failed',
      data: { attempt: 1, max: 3, summary: '2 tests red' },
    });
    const card = app.owner.updates.at(-1);
    expect(card?.body).toMatchObject({ checks: { used: 1, max: 3 } });
  });

  it('fails the task once checkRetries are used up, stops its runs and tells the owner', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Verifying' });
    const identity = app.identity.worker(task);
    for (let i = 0; i < 3; i++) {
      await app.reportChecks.execute(identity, { passed: false, summary: 'red' });
    }
    app.clearEffects();

    const result = await app.reportChecks.execute(identity, {
      passed: false,
      summary: 'still red',
    });

    expect(result).toEqual({ outcome: 'failed', max: 3 });
    expect(app.task(task.id)).toMatchObject({
      stage: 'Failed',
      resumeStage: 'Verifying',
      reason: 'Checks still failing after 3 retries: still red',
    });
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      data: { from: 'Verifying', to: 'Failed', cause: 'checks_exhausted' },
    });
    expect(app.runs.calls).toEqual([{ type: 'stop_task_runs', taskId: task.id }]);
    const system = app.messagesOf(thread.id).filter((m) => m.kind === 'system');
    expect(system).toHaveLength(1);
    expect(system[0]?.body.text).toContain('failed');
  });
});

describe('ReportPr', () => {
  it('moves to PR Open, stores the PR, creates the watch and posts a result card', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Reviewing' });

    await app.reportPr.execute(app.identity.worker(task), PR);

    expect(app.task(task.id)).toMatchObject({ stage: 'PR Open', pr: PR });
    expect(app.db.tables.watches.get(task.id)).toEqual(newWatch(task.id, 7));
    const results = app.messagesOf(thread.id).filter((m) => m.kind === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]?.body).toEqual({
      taskId: task.id,
      summary: 'Draft PR #7 opened',
      prUrl: PR.url,
    });
    expect(app.db.tables.journal.map((e) => e.type)).toContain('pr_reported');
  });

  it('after a fix push goes Fixing -> PR Open, keeps the watch state and posts no second result card', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Reviewing' });
    await app.reportPr.execute(app.identity.worker(task), PR);
    const state = { headSha: 'abc', checks: [], reviews: [], seenCommentIds: ['issue:3'] };
    await app.uow.run((tx) => tx.watches.save({ ...newWatch(task.id, 7), state }));
    await app.uow.run(async (tx) => {
      await tx.tasks.save({ ...app.task(task.id), stage: 'Fixing' });
    });

    await app.reportPr.execute(app.identity.worker(task), PR);

    expect(app.task(task.id).stage).toBe('PR Open');
    expect(app.db.tables.watches.get(task.id)?.state).toEqual(state);
    expect(app.messagesOf(thread.id).filter((m) => m.kind === 'result')).toHaveLength(1);
  });

  it('cannot open a PR straight from Implementing', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await expect(app.reportPr.execute(app.identity.worker(task), PR)).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    expect(app.db.tables.watches.size).toBe(0);
    expect(app.task(task.id).pr).toBeNull();
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
      app.reportChecks.execute(identity, { passed: true, summary: 's' }),
      app.reportPr.execute(identity, PR),
      app.askOwner.execute(identity, { question: 'q?' }),
    ];

    for (const call of calls) await expect(call).rejects.toBeInstanceOf(ForbiddenError);
    expect(app.task(task.id).stage).toBe('Cancelled');
    expect(app.owner.delivered).toEqual([]);
  });
});
