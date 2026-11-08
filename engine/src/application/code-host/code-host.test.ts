import { describe, expect, it } from 'vitest';
import type { CheckConclusion, PullRequestSnapshot } from '../../domain/index.js';
import { buildTestApp, type TestApp } from '../testing/build-test-app.js';

const PR = { number: 7, url: 'https://github.com/o/r/pull/7' };
const HEAD_1 = 'aaaaaaa1111';
const HEAD_2 = 'bbbbbbb2222';
const HEAD_3 = 'ccccccc3333';

function check(id: number, name: string, conclusion: CheckConclusion | null) {
  return {
    id,
    name,
    status: conclusion === null ? ('in_progress' as const) : ('completed' as const),
    conclusion,
    url: `https://ci.example/${name}/${id}`,
  };
}

function snapshot(over: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return { headSha: HEAD_1, checks: [], reviews: [], comments: [], ...over };
}

const approval = (id = 1) => ({ id, reviewer: 'alice', state: 'approved' as const });
const human = (id: number, author: string, body: string) => ({
  id: `issue:${id}`,
  author,
  isBot: false,
  body,
});

/** A task whose draft PR #7 is open, with `alice` as the only allowed reviewer. */
async function openPr(app: TestApp) {
  const config = app.config.current();
  app.config.set({ ...config, allowlist: { ...config.allowlist, githubReviewers: ['alice'] } });
  const seeded = await app.seed.task({ stage: 'Reviewing' });
  await app.reportPr.execute(app.identity.worker(seeded.task), PR);
  app.clearEffects();
  return seeded;
}

async function poll(app: TestApp, next: PullRequestSnapshot): Promise<void> {
  app.codeHost.set(PR.number, next);
  await app.pollPullRequests.execute();
}

const systemTexts = (app: TestApp, threadId: string): string[] =>
  app
    .messagesOf(threadId)
    .filter((m) => m.kind === 'system')
    .map((m) => String(m.body.text));

const workerInput = (app: TestApp, taskId: string): string[] =>
  [...app.db.tables.messages.values()]
    .filter((m) => m.kind === 'owner' && m.taskId === taskId)
    .map((m) => String(m.body.text));

const workerRuns = (app: TestApp) => app.runs.calls.filter((c) => c.type === 'worker_run');

describe('PollPullRequests: nothing changed', () => {
  it('reads the host but changes nothing and says nothing (CI-02)', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);
    const running = snapshot({ checks: [check(1, 'test', null)] });

    await poll(app, running);
    app.clearEffects();
    const journalBefore = app.db.tables.journal.length;
    const messagesBefore = app.messagesOf(thread.id).length;
    app.clock.advanceMinutes(1);
    await poll(app, running);

    expect(app.messagesOf(thread.id)).toHaveLength(messagesBefore);
    expect(app.db.tables.journal).toHaveLength(journalBefore);
    expect(app.runs.calls).toEqual([]);
    expect(app.owner.delivered).toEqual([]);
    expect(app.task(task.id).stage).toBe('PR Open');
    expect(app.db.tables.watches.get(task.id)?.lastCheckedAt).toBe(app.clock.now());
    expect(app.codeHost.reads).toEqual([7, 7]);
    expect(app.logger.infos.filter((i) => i.context['event'] === 'watch.polled')).toEqual([]);
  });

  it('does nothing for a PR the host has no news about, even before the first poll', async () => {
    const app = buildTestApp();
    const { thread } = await openPr(app);

    await poll(app, snapshot());

    expect(systemTexts(app, thread.id)).toEqual([]);
    expect(app.runs.calls).toEqual([]);
  });
});

describe('PollPullRequests: CI result', () => {
  it('posts the green result and waits for review, then finishes on approval (CI-03, CI-08)', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);

    await poll(
      app,
      snapshot({ checks: [check(1, 'test', 'success'), check(2, 'lint', 'success')] }),
    );

    expect(systemTexts(app, thread.id)).toEqual(['CI passed on aaaaaaa (2 checks).']);
    expect(app.task(task.id).stage).toBe('PR Open');
    const list = await app.listTasks.execute(app.identity.dispatcher(thread.id));
    expect(list.tasks[0]?.waitingFor).toBe('review');

    await poll(
      app,
      snapshot({
        checks: [check(1, 'test', 'success'), check(2, 'lint', 'success')],
        reviews: [approval()],
      }),
    );

    expect(app.task(task.id).stage).toBe('Done');
    const result = app
      .messagesOf(thread.id)
      .filter((m) => m.kind === 'result')
      .at(-1);
    expect(result?.body.summary).toContain('CI is green on aaaaaaa and alice approved');
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      data: { to: 'Done', cause: 'ci_green_approved' },
    });
  });

  it('finishes when the approval came first and CI turned green later', async () => {
    const app = buildTestApp();
    const { task } = await openPr(app);

    await poll(app, snapshot({ checks: [check(1, 'test', null)], reviews: [approval()] }));
    expect(app.task(task.id).stage).toBe('PR Open');
    await poll(app, snapshot({ checks: [check(1, 'test', 'success')], reviews: [approval()] }));

    expect(app.task(task.id).stage).toBe('Done');
  });

  it('shows ci as the wait while checks run', async () => {
    const app = buildTestApp();
    const { thread } = await openPr(app);

    await poll(app, snapshot({ checks: [check(1, 'test', null)] }));

    const list = await app.listTasks.execute(app.identity.dispatcher(thread.id));
    expect(list.tasks[0]?.waitingFor).toBe('ci');
  });

  it('goes to Fixing on a red CI and gives the worker the failing checks with their links (CI-04)', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);

    await poll(
      app,
      snapshot({ checks: [check(1, 'test', 'failure'), check(2, 'lint', 'success')] }),
    );

    expect(app.task(task.id)).toMatchObject({ stage: 'Fixing', counters: { ciFixRounds: 1 } });
    expect(systemTexts(app, thread.id)).toContain('CI failed on aaaaaaa: test.');
    expect(app.logger.infos.filter((i) => i.context['event'] === 'watch.polled')).toMatchObject([
      { context: { taskId: task.id } },
    ]);
    const [input] = workerInput(app, task.id);
    expect(input).toContain('CI failed on PR #7');
    expect([...app.db.tables.messages.values()].find((m) => m.kind === 'owner')?.body.source).toBe(
      'ci',
    );
    expect(input).toContain('- test: https://ci.example/test/1');
    expect(input).not.toContain('lint');
    expect(app.runs.calls).toEqual([
      { type: 'deliver_to_worker', taskId: task.id },
      { type: 'worker_run', taskId: task.id, reason: 'resume' },
    ]);
    expect(app.db.tables.journal.some((e) => e.type === 'ci_fix_round')).toBe(true);
  });

  it('blocks with an explanation once the fix rounds are used up (CI-04)', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);
    const worker = app.identity.worker(task);

    for (const head of [HEAD_1, HEAD_2]) {
      await poll(app, snapshot({ headSha: head, checks: [check(1, 'test', 'failure')] }));
      expect(app.task(task.id).stage).toBe('Fixing');
      await app.reportPr.execute(worker, PR);
    }
    await poll(app, snapshot({ headSha: HEAD_3, checks: [check(1, 'test', 'failure')] }));

    expect(app.task(task.id)).toMatchObject({
      stage: 'Blocked',
      resumeStage: 'PR Open',
      reason: 'CI is still red after 2 fix rounds',
    });
    const [card] = app.messagesOf(thread.id).filter((m) => m.kind === 'question');
    expect(card?.body.question).toContain('CI is still red after 2 fix rounds');
    expect(workerRuns(app)).toHaveLength(2);
  });
});

describe('PollPullRequests: flaky CI', () => {
  it('re-runs once when checks that passed on this commit turn red, then treats it as real', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);
    await poll(app, snapshot({ checks: [check(1, 'test', 'success')] }));
    app.clearEffects();

    await poll(
      app,
      snapshot({ checks: [check(1, 'test', 'success'), check(2, 'test', 'failure')] }),
    );

    expect(app.codeHost.reruns).toEqual([{ repo: null, prNumber: 7, headSha: HEAD_1 }]);
    expect(app.task(task.id)).toMatchObject({ stage: 'PR Open', counters: { ciFixRounds: 0 } });
    expect(systemTexts(app, thread.id)).toContain('Possibly flaky — re-running once.');
    expect(app.db.tables.journal.some((e) => e.type === 'ci_rerun')).toBe(true);
    expect(workerRuns(app)).toEqual([]);

    await poll(
      app,
      snapshot({
        checks: [
          check(1, 'test', 'success'),
          check(2, 'test', 'failure'),
          check(3, 'test', 'failure'),
        ],
      }),
    );

    expect(app.codeHost.reruns).toHaveLength(1);
    expect(app.task(task.id)).toMatchObject({ stage: 'Fixing', counters: { ciFixRounds: 1 } });
  });

  it('is not flaky when nothing passed on this commit before', async () => {
    const app = buildTestApp();
    const { task } = await openPr(app);

    await poll(app, snapshot({ checks: [check(1, 'test', 'failure')] }));

    expect(app.codeHost.reruns).toEqual([]);
    expect(app.task(task.id).stage).toBe('Fixing');
  });

  it('handles the red as real when the re-run cannot be started', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);
    await poll(app, snapshot({ checks: [check(1, 'test', 'success')] }));
    app.codeHost.failNextRerun(new Error('403'));

    await poll(
      app,
      snapshot({ checks: [check(1, 'test', 'success'), check(2, 'test', 'failure')] }),
    );

    expect(app.logger.entries.some((e) => e.message === 'could not re-run failed checks')).toBe(
      true,
    );
    expect(systemTexts(app, thread.id)).toContain(
      'Could not re-run the checks — treating the failure as real.',
    );
    expect(app.task(task.id).stage).toBe('PR Open');

    await poll(
      app,
      snapshot({ checks: [check(1, 'test', 'success'), check(2, 'test', 'failure')] }),
    );

    expect(app.task(task.id).stage).toBe('Fixing');
    expect(app.codeHost.reruns).toEqual([]);
  });
});

describe('PollPullRequests: review', () => {
  it('sends an allowlisted reviewer comment to the worker (CI-05)', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);

    await poll(app, snapshot({ comments: [human(10, 'alice', 'Please rename `foo` to `bar`.')] }));

    expect(app.task(task.id)).toMatchObject({ stage: 'Fixing', counters: { reviewRounds: 1 } });
    expect(workerInput(app, task.id)[0]).toContain(
      '- alice:\n<untrusted-content source="pr-comment" author="alice">\nPlease rename `foo` to `bar`.\n</untrusted-content>',
    );
    expect(workerRuns(app)).toHaveLength(1);
    expect(systemTexts(app, thread.id)).toContain('Review feedback received — fixing (round 1/3).');
    expect(app.db.tables.watches.get(task.id)?.summary?.comments).toMatchObject([
      { id: 'issue:10', author: 'alice', handling: 'handled' },
    ]);
  });

  it('treats a change request like feedback', async () => {
    const app = buildTestApp();
    const { task } = await openPr(app);

    await poll(
      app,
      snapshot({ reviews: [{ id: 5, reviewer: 'alice', state: 'changes_requested' }] }),
    );

    expect(app.task(task.id).stage).toBe('Fixing');
    expect(workerInput(app, task.id)[0]).toContain('alice requested changes');
    expect(app.db.tables.watches.get(task.id)?.summary?.review).toBe('changes_requested');
  });

  it('blocks when the review rounds are used up', async () => {
    const app = buildTestApp();
    const { task } = await openPr(app);
    const worker = app.identity.worker(task);

    for (const id of [10, 11, 12]) {
      await poll(app, snapshot({ comments: [human(id, 'alice', `round ${id}`)] }));
      await app.reportPr.execute(worker, PR);
    }
    await poll(app, snapshot({ comments: [human(13, 'alice', 'one more')] }));

    expect(app.task(task.id)).toMatchObject({
      stage: 'Blocked',
      reason: 'Review feedback arrived after all 3 review rounds',
    });
  });

  it('ignores bots, the Jarvis account and people off the allowlist (CI-06)', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);

    await poll(
      app,
      snapshot({
        comments: [
          { id: 'issue:1', author: 'dependabot', isBot: true, body: 'bump' },
          human(2, 'jarvis-bot', 'pushed a fix'),
          human(3, 'bob', 'looks odd to me'),
        ],
      }),
    );

    expect(app.task(task.id).stage).toBe('PR Open');
    expect(systemTexts(app, thread.id)).toEqual([]);
    expect(app.runs.calls).toEqual([]);
    const comments = app.db.tables.watches.get(task.id)?.summary?.comments ?? [];
    expect(comments.map((c) => [c.author, c.handling, c.ignoredBecause])).toEqual([
      ['dependabot', 'ignored', 'bot'],
      ['jarvis-bot', 'ignored', 'bot'],
      ['bob', 'ignored', 'not_allowlisted'],
    ]);
    const noted = app.db.tables.journal.filter((e) => e.type === 'comment_ignored');
    expect(noted.map((e) => e.data.author)).toEqual(['bob']);

    await poll(app, snapshot({ checks: [check(1, 'test', 'success')], reviews: [approval()] }));
    const final = app
      .messagesOf(thread.id)
      .filter((m) => m.kind === 'result')
      .at(-1);
    expect(final?.body.summary).toContain('1 comment(s) from bob were not acted on');
  });
});

describe('PollPullRequests: missed events and new commits', () => {
  it('handles everything that happened while the laptop slept once, in one worker round (CI-09)', async () => {
    const app = buildTestApp();
    const { task } = await openPr(app);
    const whileAsleep = snapshot({
      checks: [check(1, 'test', 'failure')],
      comments: [human(10, 'alice', 'also fix the typo')],
    });

    await poll(app, whileAsleep);
    const afterFirst = {
      messages: app.db.tables.messages.size,
      journal: app.db.tables.journal.length,
      runs: workerRuns(app).length,
    };
    await poll(app, whileAsleep);
    await poll(app, whileAsleep);

    expect(afterFirst.runs).toBe(1);
    expect(app.db.tables.messages.size).toBe(afterFirst.messages);
    expect(app.db.tables.journal).toHaveLength(afterFirst.journal);
    expect(workerRuns(app)).toHaveLength(1);
    expect(workerInput(app, task.id)).toHaveLength(1);
    expect(workerInput(app, task.id)[0]).toContain('CI failed');
    expect(workerInput(app, task.id)[0]).toContain('also fix the typo');
    expect(app.task(task.id).counters).toMatchObject({ ciFixRounds: 1, reviewRounds: 1 });
  });

  it('does not judge a task while the worker is fixing it, and reports the new head afterwards (CI-07)', async () => {
    const app = buildTestApp();
    const { task } = await openPr(app);
    await poll(app, snapshot({ checks: [check(1, 'test', 'failure')] }));
    expect(app.task(task.id).stage).toBe('Fixing');
    app.codeHost.reads.length = 0;

    await poll(app, snapshot({ headSha: HEAD_2, checks: [check(2, 'test', 'success')] }));
    expect(app.codeHost.reads).toEqual([]);

    await app.reportPr.execute(app.identity.worker(task), PR);
    await poll(app, snapshot({ headSha: HEAD_2, checks: [check(2, 'test', 'success')] }));

    expect(app.db.tables.watches.get(task.id)?.summary).toMatchObject({
      headSha: HEAD_2,
      ciGreen: true,
      earlierChecks: [{ name: 'test', status: 'failed' }],
    });
  });

  it('does not let an approval finish the task while the new commit is still being checked (CI-07)', async () => {
    const app = buildTestApp();
    const { task } = await openPr(app);
    await poll(app, snapshot({ checks: [check(1, 'test', 'success')] }));

    await poll(
      app,
      snapshot({ headSha: HEAD_2, checks: [check(2, 'test', null)], reviews: [approval()] }),
    );

    expect(app.task(task.id).stage).toBe('PR Open');
    expect(app.db.tables.watches.get(task.id)?.summary).toMatchObject({
      headSha: HEAD_2,
      ciGreen: false,
      review: 'approved',
      earlierChecks: [{ name: 'test', status: 'passed' }],
    });
  });

  it('keeps the old checks out of the result of the new commit (CI-07)', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPr(app);
    await poll(app, snapshot({ checks: [check(1, 'test', 'success')] }));
    app.clearEffects();

    await poll(app, snapshot({ headSha: HEAD_2, checks: [check(2, 'test', 'failure')] }));

    expect(systemTexts(app, thread.id)).toContain('CI failed on bbbbbbb: test.');
    expect(app.task(task.id).stage).toBe('Fixing');
  });
});

describe('PollPullRequests: the task’s own repo (ADR-0019)', () => {
  const TARGET = { owner: 'burnjohn', name: 'quick-blog' };

  /** A task that opened its PR in a repo other than the default one. */
  async function openPrInTargetRepo(app: TestApp) {
    const config = app.config.current();
    app.config.set({ ...config, allowlist: { ...config.allowlist, githubReviewers: ['alice'] } });
    const seeded = await app.seed.task({ stage: 'Reviewing', targetRepo: TARGET });
    await app.reportPr.execute(app.identity.worker(seeded.task), PR);
    app.clearEffects();
    return seeded;
  }

  it('reads the PR from the target repo, not the default one', async () => {
    const app = buildTestApp();
    const { task } = await openPrInTargetRepo(app);
    app.codeHost.setFor(TARGET, PR.number, snapshot({ checks: [check(1, 'test', 'success')] }));

    await app.pollPullRequests.execute();

    expect(app.codeHost.readRepos).toEqual(['burnjohn/quick-blog']);
    expect(app.task(task.id).stage).toBe('PR Open');
    expect(app.db.tables.watches.get(task.id)?.summary?.ciGreen).toBe(true);
  });

  it('never judges a same-numbered PR of the default repo', async () => {
    const app = buildTestApp();
    const { task, thread } = await openPrInTargetRepo(app);
    // Someone else's PR #7, red, in the default repo. The task must not see it at all.
    app.codeHost.set(PR.number, snapshot({ checks: [check(9, 'test', 'failure')] }));

    await app.pollPullRequests.execute();

    expect(app.task(task.id).stage).toBe('PR Open');
    expect(app.db.tables.watches.get(task.id)?.state).toBeNull();
    expect(systemTexts(app, thread.id)).toEqual([]);
    expect(app.logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'watcher failed for a PR',
        context: expect.objectContaining({ taskId: task.id }),
      }),
    );
  });

  it('re-runs the failed checks in the target repo (CI-04)', async () => {
    const app = buildTestApp();
    await openPrInTargetRepo(app);
    const green = snapshot({ checks: [check(1, 'test', 'success')] });
    app.codeHost.setFor(TARGET, PR.number, green);
    await app.pollPullRequests.execute();
    app.clock.advanceMinutes(1);
    app.codeHost.setFor(TARGET, PR.number, snapshot({ checks: [check(1, 'test', 'failure')] }));

    await app.pollPullRequests.execute();

    expect(app.codeHost.reruns).toEqual([
      { repo: 'burnjohn/quick-blog', prNumber: PR.number, headSha: HEAD_1 },
    ]);
  });
});

describe('PollPullRequests: failures', () => {
  it('logs a PR it cannot read and still polls the others', async () => {
    const app = buildTestApp();
    const first = await openPr(app);
    const second = await app.seed.task({ stage: 'Reviewing' });
    await app.reportPr.execute(app.identity.worker(second.task), {
      number: 8,
      url: 'https://github.com/o/r/pull/8',
    });
    app.codeHost.set(7, new Error('rate limited'));
    app.codeHost.set(8, snapshot({ checks: [check(1, 'test', 'failure')] }));

    await app.pollPullRequests.execute();

    expect(app.logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'watcher failed for a PR',
        context: expect.objectContaining({ taskId: first.task.id, error: 'rate limited' }),
      }),
    );
    expect(app.task(first.task.id).stage).toBe('PR Open');
    expect(app.task(second.task.id).stage).toBe('Fixing');
  });

  it('leaves the stored state alone when handling fails, so the change is seen again', async () => {
    const app = buildTestApp();
    const { task } = await openPr(app);
    const red = snapshot({ checks: [check(1, 'test', 'failure')] });
    // A task whose thread vanished cannot get its messages: the whole tick rolls back.
    app.db.tables.threads.delete(task.threadId);

    await poll(app, red);

    expect(app.logger.entries.some((e) => e.message === 'watcher failed for a PR')).toBe(true);
    expect(app.db.tables.watches.get(task.id)?.state).toBeNull();
    expect(app.task(task.id).stage).toBe('PR Open');
  });
});
