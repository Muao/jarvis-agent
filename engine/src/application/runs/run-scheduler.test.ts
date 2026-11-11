import { JarvisConfigSchema } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createTaskInNewThread,
  systemTexts,
  type TestApp,
} from '../testing/index.js';

function configWith(limits: Record<string, number>) {
  return JarvisConfigSchema.parse({ repo: { path: '/jarvis/repo' }, limits });
}

const app = (): TestApp => buildTestApp({ realRuns: true });

describe('RunScheduler worker slots (DSP-08, LIM-05)', () => {
  it('queues the second task with a position message and starts it when the first exits', async () => {
    const a = app();
    const first = await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);

    expect(a.runner.processes.map((p) => p.spec.taskId)).toEqual([first.taskId]);
    expect(await a.scheduler.isQueued(second.taskId)).toBe(true);
    expect(systemTexts(a, second.thread.id)).toEqual([
      `Queued — position 1 in the queue, waiting for a free worker slot (in use: ${first.taskId}, Context)`,
    ]);
    expect(a.task(second.taskId).stage).toBe('Intake');

    await a.runner.forTask(first.taskId)?.succeed();

    expect(a.runner.processes.map((p) => p.spec.taskId)).toEqual([first.taskId, second.taskId]);
    expect(await a.scheduler.isQueued(second.taskId)).toBe(false);
    expect(a.task(second.taskId).stage).toBe('Context');
  });

  it('numbers the queue and serves it first in, first out', async () => {
    const a = app();
    const first = await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);
    const third = await createTaskInNewThread(a);

    expect(systemTexts(a, third.thread.id)).toEqual([
      expect.stringMatching(/^Queued — position 2 in the queue/),
    ]);
    await a.runner.forTask(first.taskId)?.succeed();
    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([second.taskId]);
  });

  it('reads the slot limit when it decides, so a raised limit applies without a restart', async () => {
    const a = app();
    await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);
    expect(a.runner.live).toHaveLength(1);

    a.config.set(configWith({ maxConcurrentWorkers: 2 }));
    await a.scheduler.resumeQueued();

    expect(a.runner.live.map((p) => p.spec.taskId)).toContain(second.taskId);
  });

  it('never starts two processes for the same request', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);

    await Promise.all([
      a.scheduler.requestWorkerRun(taskId),
      a.scheduler.requestWorkerRun(taskId),
      a.scheduler.requestWorkerRun(second.taskId),
      a.scheduler.requestWorkerRun(second.taskId),
    ]);

    expect(a.runner.processes).toHaveLength(1);
    expect(systemTexts(a, second.thread.id)).toEqual([
      expect.stringMatching(/^Queued — position 1 in the queue/),
    ]);
  });

  it('answers an owner message to a queued task at once, saying why it waits', async () => {
    const a = app();
    const first = await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);

    await a.postOwnerMessage.execute({ threadId: second.thread.id, text: 'wait for me' });

    expect(systemTexts(a, second.thread.id).at(-1)).toBe(
      `Your message waits for the worker of ${second.taskId}: position 1 in the queue, waiting for a free worker slot (in use: ${first.taskId}, Context). "Send now" hands it to the dispatcher instead.`,
    );
  });

  it('skips a held task in the queue and starts it once resumed', async () => {
    const a = app();
    const first = await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);
    const third = await createTaskInNewThread(a);
    await a.holdTask.execute({ taskId: second.taskId });

    await a.runner.forTask(first.taskId)?.succeed();
    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([third.taskId]);
    expect(await a.scheduler.isQueued(second.taskId)).toBe(true);

    await a.runner.forTask(third.taskId)?.succeed();
    expect(a.runner.live).toEqual([]);

    await a.resumeTask.execute({ taskId: second.taskId });
    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([second.taskId]);
  });

  it('says a held task waits for the owner when a message reaches it', async () => {
    const a = app();
    await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);
    await a.holdTask.execute({ taskId: second.taskId });

    await a.postOwnerMessage.execute({ threadId: second.thread.id, text: 'and also this' });

    expect(systemTexts(a, second.thread.id).at(-1)).toBe(
      `Your message waits for the worker of ${second.taskId}: on hold until you resume it. "Send now" hands it to the dispatcher instead.`,
    );
  });

  it("runs a task's worker on the model the owner chose", async () => {
    const a = app();
    const first = await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);
    await a.setTaskModel.execute({ taskId: second.taskId, model: 'fable' });

    await a.runner.forTask(first.taskId)?.succeed();

    expect(a.runner.forTask(first.taskId)?.spec.model).not.toBe('fable');
    expect(a.runner.forTask(second.taskId)?.spec.model).toBe('fable');
  });

  it('drops queued work of a cancelled task', async () => {
    const a = app();
    const first = await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);

    await a.cancelTask.execute({ taskId: second.taskId });
    await a.runner.forTask(first.taskId)?.succeed();

    expect(await a.scheduler.isQueued(second.taskId)).toBe(false);
    expect(a.runner.processes.map((p) => p.spec.taskId)).toEqual([first.taskId]);
  });

  it('stops the live worker of a cancelled task', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);

    await a.cancelTask.execute({ taskId });

    expect(a.runner.forTask(taskId)?.stopped).toBe(true);
    expect([...a.db.tables.runs.values()].map((r) => r.status)).toEqual(['stopped']);
  });

  it('does not start a worker for a task that waits for the owner', async () => {
    const a = app();
    const { task } = await a.seed.task({ stage: 'Spec Review' });

    await a.scheduler.requestWorkerRun(task.id);

    expect(a.runner.processes).toHaveLength(0);
    expect(await a.scheduler.isQueued(task.id)).toBe(false);
  });

  it('reports a runner that cannot start as a failed run and a message', async () => {
    const a = app();
    a.runner.failNext(new Error('spawn claude ENOENT'));

    const { thread } = await createTaskInNewThread(a);

    const runs = [...a.db.tables.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed' });
    expect(runs[0]?.error).toContain('spawn claude ENOENT');
    expect(await a.scheduler.isQueued('T-1')).toBe(false);
    expect(systemTexts(a, thread.id)).toEqual([
      'The worker run of T-1 failed: could not start claude: spawn claude ENOENT',
    ]);
  });
});

describe('RunScheduler daily budget (LIM-04)', () => {
  it('starts nothing once the budget is used up, tells the thread once, and resumes when it is raised', async () => {
    const a = app();
    a.config.set(configWith({ dailyBudgetTokens: 10 }));
    const first = await createTaskInNewThread(a);
    await a.runner.forTask(first.taskId)?.succeed(1.5);

    const second = await createTaskInNewThread(a);
    await a.scheduler.requestWorkerRun(second.taskId);

    expect(a.runner.processes).toHaveLength(1);
    expect(systemTexts(a, second.thread.id)).toHaveLength(1);
    expect(systemTexts(a, second.thread.id)[0]).toContain('Daily budget of 10 tokens is used up');
    expect(await a.scheduler.isQueued(second.taskId)).toBe(true);

    a.config.set(configWith({ dailyBudgetTokens: 1_000_000 }));
    await a.scheduler.resumeQueued();

    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([second.taskId]);
  });

  it('resumes the next day because usage counts from local midnight', async () => {
    const a = app();
    a.config.set(configWith({ dailyBudgetTokens: 10 }));
    const first = await createTaskInNewThread(a);
    await a.runner.forTask(first.taskId)?.succeed(2);
    const second = await createTaskInNewThread(a);
    expect(a.runner.live).toHaveLength(0);

    a.clock.advanceMinutes(48 * 60);
    await a.scheduler.resumeQueued();

    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([second.taskId]);
  });

  it('pauses dispatcher turns too, with one message per thread and day', async () => {
    const a = app();
    a.config.set(configWith({ dailyBudgetTokens: 10 }));
    const first = await createTaskInNewThread(a);
    await a.runner.forTask(first.taskId)?.succeed(2);

    const posted = await a.postOwnerMessage.execute({ text: 'status?' });
    await a.postOwnerMessage.execute({ threadId: posted.threadId, text: 'hello?' });

    expect(a.runner.forThread(posted.threadId, 'dispatcher')).toBeUndefined();
    expect(systemTexts(a, posted.threadId)).toHaveLength(1);

    a.config.set(configWith({ dailyBudgetTokens: 1_000_000 }));
    await a.scheduler.resumeQueued();
    expect(a.runner.forThread(posted.threadId, 'dispatcher')?.spec.firstMessage).toContain(
      'status?\n\nhello?',
    );
  });
});

describe("RunScheduler reset of today's usage (LIM-04)", () => {
  it('starts queued work at once and counts only runs started after the reset', async () => {
    const a = app();
    a.config.set(configWith({ dailyBudgetTokens: 10 }));
    const first = await createTaskInNewThread(a);
    await a.runner.forTask(first.taskId)?.succeed(1.5);
    const second = await createTaskInNewThread(a);
    expect(a.runner.live).toHaveLength(0);

    a.clock.advanceMinutes(1);
    const usage = await a.resetDailyUsage.execute();

    expect(usage).toMatchObject({ todayTokens: 0, paused: false });
    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([second.taskId]);
    expect((await a.getOverview.execute()).usage).toMatchObject({ todayTokens: 0, paused: false });
  });

  it('announces a later exhaustion again to a thread that was told before the reset', async () => {
    const a = app();
    a.config.set(configWith({ dailyBudgetTokens: 10 }));
    const first = await createTaskInNewThread(a);
    await a.runner.forTask(first.taskId)?.succeed(1.5);
    const second = await createTaskInNewThread(a);
    expect(systemTexts(a, second.thread.id)).toHaveLength(1);

    a.clock.advanceMinutes(1);
    await a.resetDailyUsage.execute();
    a.clock.advanceMinutes(1);
    await a.runner.forTask(second.taskId)?.succeed(2);
    await a.scheduler.requestWorkerRun(second.taskId);

    expect(
      systemTexts(a, second.thread.id).filter((text) => text.includes('Daily budget')),
    ).toHaveLength(2);
  });
});

describe('RunScheduler expired claude login', () => {
  const expired = {
    status: 'failed',
    summary: 'Login expired',
    details: [],
    loginExpired: true,
  } as const;

  it('starts nothing, keeps the work queued and tells the thread once', async () => {
    const a = app();
    a.connections.cached.set('claude', expired);

    const { taskId, thread } = await createTaskInNewThread(a);
    await a.scheduler.requestWorkerRun(taskId);

    expect(a.runner.processes).toHaveLength(0);
    expect(await a.scheduler.isQueued(taskId)).toBe(true);
    expect(systemTexts(a, thread.id)).toHaveLength(1);
    expect(systemTexts(a, thread.id)[0]).toContain('claude login has expired');

    a.connections.cached.set('claude', { status: 'ok', summary: 'Logged in', details: [] });
    await a.scheduler.resumeQueued();

    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([taskId]);
  });

  it('tells the same thread again when the expiry recurs the same day', async () => {
    const a = app();
    a.connections.cached.set('claude', expired);
    const { taskId, thread } = await createTaskInNewThread(a);
    expect(systemTexts(a, thread.id)).toHaveLength(1);
    expect(await a.scheduler.isQueued(taskId)).toBe(true);

    a.connections.cached.set('claude', { status: 'ok', summary: 'Logged in', details: [] });
    await a.scheduler.resumeQueued();
    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([taskId]);

    a.connections.cached.set('claude', expired);
    await a.scheduler.requestDispatcherTurn(thread.id);

    expect(a.runner.forThread(thread.id, 'dispatcher')).toBeUndefined();
    const notices = systemTexts(a, thread.id).filter((t) => t.includes('claude login has expired'));
    expect(notices).toHaveLength(2);
  });

  it('holds dispatcher turns too', async () => {
    const a = app();
    a.connections.cached.set('claude', expired);

    const posted = await a.postOwnerMessage.execute({ text: 'status?' });

    expect(a.runner.forThread(posted.threadId, 'dispatcher')).toBeUndefined();
    expect(systemTexts(a, posted.threadId)).toHaveLength(1);
  });

  it('does not stop work for a failed probe that is not an expiry', async () => {
    const a = app();
    a.connections.cached.set('claude', { status: 'failed', summary: 'timeout', details: [] });

    const { taskId } = await createTaskInNewThread(a);

    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([taskId]);
  });
});

describe('RunScheduler dispatcher turns (DSP-04)', () => {
  it('runs turns of one thread one at a time and later messages in the next turn', async () => {
    const a = app();
    const posted = await a.postOwnerMessage.execute({ text: 'first' });
    await a.postOwnerMessage.execute({ threadId: posted.threadId, text: 'second' });
    await a.scheduler.requestDispatcherTurn(posted.threadId);

    expect(a.runner.processes).toHaveLength(1);
    expect(a.runner.processes[0]?.spec.firstMessage).toContain('first');
    expect(a.runner.processes[0]?.spec.firstMessage).not.toContain('second');

    await a.runner.processes[0]?.succeed();

    expect(a.runner.processes).toHaveLength(2);
    expect(a.runner.processes[1]?.spec.firstMessage).toContain('second');
    expect(a.messagesOf(posted.threadId).map((m) => m.body.delivery)).toEqual([
      'delivered',
      'delivered',
    ]);

    await a.runner.processes[1]?.succeed();
    expect(a.runner.processes).toHaveLength(2);
  });

  it('runs turns of different threads in parallel and takes no worker slot', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const one = await a.postOwnerMessage.execute({ text: 'thread one' });
    const two = await a.postOwnerMessage.execute({ text: 'thread two' });

    expect(a.runner.live.map((p) => p.spec.role).sort()).toEqual([
      'dispatcher',
      'dispatcher',
      'worker',
    ]);
    expect(a.runner.forThread(one.threadId, 'dispatcher')).toBeDefined();
    expect(a.runner.forThread(two.threadId, 'dispatcher')).toBeDefined();
    expect(a.runner.forTask(taskId)).toBeDefined();
  });

  it('starts the dispatcher in the repository without stdin kept open and resumes its session', async () => {
    const a = app();
    const posted = await a.postOwnerMessage.execute({ text: 'one' });
    const process = a.runner.processes[0];
    expect(process?.spec).toMatchObject({
      role: 'dispatcher',
      cwd: '/jarvis/repo',
      keepStdinOpen: false,
      threadId: posted.threadId,
      model: 'sonnet',
    });
    expect(process?.spec.taskId).toBeUndefined();
    expect(process?.spec.resumeSessionId).toBeUndefined();
    await process?.reportSession('claude-d1');
    await process?.succeed();

    await a.postOwnerMessage.execute({ threadId: posted.threadId, text: 'two' });

    expect(a.runner.processes[1]?.spec.resumeSessionId).toBe('claude-d1');
  });
});
