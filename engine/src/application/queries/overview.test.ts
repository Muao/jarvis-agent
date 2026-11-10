import { OverviewDtoSchema } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createTaskInNewThread,
  identityOfProcess,
  taskInPrOpen,
  FLOW_PR,
} from '../testing/index.js';

describe('GetOverview', () => {
  it('shows an idle system: one free slot, no queue, nothing spent', async () => {
    const app = buildTestApp({ realRuns: true });

    const overview = OverviewDtoSchema.parse(await app.getOverview.execute());

    expect(overview).toMatchObject({
      usage: { todayUsd: 0, budgetUsd: 20, paused: false },
      dispatcher: { status: 'idle', action: null, runningSince: null, sessionId: null },
      workers: [{ state: 'free' }],
      queue: [],
      watching: [],
      waitingForOwner: 0,
      prsOpen: 0,
      events: [],
    });
    expect(Date.parse(overview.usage.resetsAt)).toBeGreaterThan(Date.parse(app.clock.now()));
  });

  it('shows the running dispatcher and worker with what they are doing, and the queue behind them', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app, { title: 'Add endpoint' });
    await app.runner.forTask(taskId)?.emit({
      kind: 'tool_use',
      payload: { toolUseId: 'tu-1', name: 'Bash', input: { command: 'pnpm test\npnpm lint' } },
    });
    const asking = await app.seed.thread();
    await app.postOwnerMessage.execute({ threadId: asking.id, text: 'What is in Notion?' });
    app.clock.advanceMinutes(1);
    const second = await createTaskInNewThread(app);

    const overview = OverviewDtoSchema.parse(await app.getOverview.execute());

    expect(overview.workers).toMatchObject([
      {
        state: 'busy',
        taskId,
        title: 'Add endpoint',
        stage: 'Context',
        action: 'Bash: pnpm test',
        sessionId: 's-1',
        runCostUsd: 0,
      },
    ]);
    expect(overview.dispatcher).toMatchObject({
      status: 'running',
      action: 'Thinking',
      sessionId: 's-2',
    });
    expect(overview.dispatcher.runningSince).not.toBeNull();
    expect(overview.queue).toMatchObject([
      { taskId: second.taskId, what: 'new_task', position: 1, since: app.clock.now() },
    ]);
  });

  it('marks a silent worker stalled (DSP-09) and a worker waiting for permission', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app);
    const worker = identityOfProcess(app, 0);

    app.clock.advanceMinutes(9);
    expect((await app.getOverview.execute()).workers[0]).toMatchObject({ state: 'busy' });
    app.clock.advanceMinutes(1);
    expect((await app.getOverview.execute()).workers[0]).toMatchObject({ state: 'stalled' });

    await app.requestPermission.execute(worker, { tool_name: 'Bash', input: { command: 'ls' } });
    const overview = OverviewDtoSchema.parse(await app.getOverview.execute());
    expect(overview.workers[0]).toMatchObject({
      state: 'waiting_for_permission',
      taskId,
      action: 'Waiting for permission: Bash',
    });
    expect(overview.waitingForOwner).toBe(1);
  });

  it('shows one slot per allowed worker, free ones after the busy ones', async () => {
    const app = buildTestApp({ realRuns: true });
    app.config.set({
      ...app.config.current(),
      limits: { ...app.config.current().limits, maxConcurrentWorkers: 3 },
    });
    await createTaskInNewThread(app);

    const { workers } = OverviewDtoSchema.parse(await app.getOverview.execute());

    expect(workers.map((w) => w.state)).toEqual(['busy', 'free', 'free']);
  });

  it('maps queued work to what woke it: a new task, CI or review feedback, an owner reply', async () => {
    const app = buildTestApp();
    const { task: fixing } = await app.seed.task({ stage: 'Fixing' });
    const { task: implementing } = await app.seed.task({ stage: 'Implementing' });
    const { task: fresh } = await app.seed.task({ stage: 'Intake' });
    const since = app.clock.now();
    app.runs.queue.push(
      { taskId: fixing.id, reason: 'resume', since },
      { taskId: implementing.id, reason: 'resume', since },
      { taskId: implementing.id, reason: 'retry', since },
      { taskId: fresh.id, reason: 'start', since },
    );

    const { queue } = OverviewDtoSchema.parse(await app.getOverview.execute());

    expect(queue.map((q) => [q.position, q.what])).toEqual([
      [1, 'ci_event'],
      [2, 'owner_reply'],
      [3, 'owner_reply'],
      [4, 'new_task'],
    ]);
  });

  it('lists PRs the watcher follows with the next check time, and counts open PRs', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await taskInPrOpen(app);
    const checkedAt = app.clock.now();

    const overview = OverviewDtoSchema.parse(await app.getOverview.execute());

    expect(overview.prsOpen).toBe(1);
    expect(overview.watching).toEqual([
      {
        taskId,
        stage: 'PR Open',
        prUrl: FLOW_PR.url,
        ci: 'running',
        review: 'pending',
        lastCheckedAt: checkedAt,
        nextCheckAt: new Date(Date.parse(checkedAt) + 60_000).toISOString(),
      },
    ]);
  });

  it('keeps a PR waiting for an answer in the watch list, with no check time before the first poll', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Reviewing' });
    await app.reportPr.execute(app.identity.worker(task), FLOW_PR);
    await app.askOwner.execute(app.identity.worker(task), { question: 'Squash?' });

    const { watching, waitingForOwner } = OverviewDtoSchema.parse(await app.getOverview.execute());

    expect(watching).toMatchObject([
      {
        taskId: task.id,
        stage: 'Blocked',
        ci: null,
        review: null,
        lastCheckedAt: null,
        nextCheckAt: null,
      },
    ]);
    expect(waitingForOwner).toBe(1);
  });

  it('lists the newest journal events across tasks first, grouped for the filters', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await taskInPrOpen(app);

    const { events } = OverviewDtoSchema.parse(await app.getOverview.execute());

    expect(events[0]).toMatchObject({
      taskId,
      type: 'stage',
      text: `Draft PR #7 opened: ${FLOW_PR.url}`,
    });
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort().reverse());
    expect(events.find((e) => e.text.startsWith('Checks failed'))?.type).toBe('ci');
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it('caps the log at 100 events', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    const worker = app.identity.worker(task);
    for (let i = 0; i < 120; i++) {
      await app.reportStage.execute(worker, { stage: 'Implementing', note: `step ${i}` });
    }

    const { events } = await app.getOverview.execute();

    expect(events).toHaveLength(100);
    expect(events[0]?.text).toContain('step 119');
  });

  it('reports usage against the daily budget and pauses when it is used up (LIM-04)', async () => {
    const app = buildTestApp({ realRuns: true });
    await taskInPrOpen(app);
    expect((await app.getOverview.execute()).usage).toMatchObject({
      todayUsd: 0.5,
      budgetUsd: 20,
      paused: false,
    });

    app.config.set({
      ...app.config.current(),
      limits: { ...app.config.current().limits, dailyBudgetUsd: 0.5 },
    });
    expect((await app.getOverview.execute()).usage).toMatchObject({ budgetUsd: 0.5, paused: true });
  });

  it('shows a failed last dispatcher run as an error', async () => {
    const app = buildTestApp({ realRuns: true });
    const thread = await app.seed.thread();
    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'hi' });
    await app.runner.forThread(thread.id, 'dispatcher')?.exit({ type: 'exit', code: 1 });

    expect((await app.getOverview.execute()).dispatcher).toMatchObject({
      status: 'error',
      action: null,
      sessionId: 's-1',
    });
  });
});
