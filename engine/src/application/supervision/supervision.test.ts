import { describe, expect, it } from 'vitest';
import { startRun, type Run } from '../../domain/index.js';
import { buildTestApp, type TestApp } from '../testing/build-test-app.js';
import { activeWorkerMs } from './active-worker-time.js';

type Seeded = Awaited<ReturnType<TestApp['seed']['task']>>;

/** A worker run that the database calls `running`, started now. */
async function runningWorker(app: TestApp, { task }: Seeded, id = 'r-w1'): Promise<Run> {
  const run = startRun({
    id,
    sessionId: 's-w',
    role: 'worker',
    threadId: task.threadId,
    taskId: task.id,
    at: app.clock.now(),
  });
  await app.uow.run((tx) => tx.runs.save(run));
  return run;
}

const systemTexts = (app: TestApp, threadId: string): string[] =>
  app
    .messagesOf(threadId)
    .filter((m) => m.kind === 'system')
    .map((m) => String(m.body.text));

describe('DetectStalls', () => {
  it('warns once about a run that went quiet, and again only after new events (DSP-09)', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    const run = await runningWorker(app, seeded);
    await app.uow.run((tx) =>
      tx.runs.appendEvent(
        run.id,
        { kind: 'tool_use', payload: { toolUseId: 't1', name: 'Bash', input: {} } },
        app.clock.now(),
      ),
    );

    app.clock.advanceMinutes(9);
    await app.detectStalls.execute();
    expect(systemTexts(app, seeded.thread.id)).toEqual([]);

    app.clock.advanceMinutes(2);
    await app.detectStalls.execute();
    await app.detectStalls.execute();
    expect(systemTexts(app, seeded.thread.id)).toEqual([
      `The worker of ${seeded.task.id} has produced no events for 11 min. Last activity: tool Bash. You can stop the run in the console.`,
    ]);

    await app.uow.run((tx) =>
      tx.runs.appendEvent(run.id, { kind: 'text', payload: { text: 'back' } }, app.clock.now()),
    );
    app.clock.advanceMinutes(10);
    await app.detectStalls.execute();
    expect(systemTexts(app, seeded.thread.id)).toHaveLength(2);
  });

  it('counts a run without any event from its start', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    await runningWorker(app, seeded);

    app.clock.advanceMinutes(10);
    await app.detectStalls.execute();

    expect(systemTexts(app, seeded.thread.id)[0]).toContain('Last activity: nothing yet');
  });

  it('ignores runs that are not running', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    const run = await runningWorker(app, seeded);
    await app.uow.run((tx) => tx.runs.save({ ...run, status: 'completed' }));

    app.clock.advanceMinutes(30);
    await app.detectStalls.execute();

    expect(systemTexts(app, seeded.thread.id)).toEqual([]);
  });

  it('reports a permission nobody answered once, instead of a second generic warning', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    const run = await runningWorker(app, seeded);
    await app.requestPermission.execute(
      { ...app.identity.worker(seeded.task), runId: run.id },
      { tool_name: 'Bash', input: { command: 'rm -rf build' } },
    );

    app.clock.advanceMinutes(12);
    await app.detectStalls.execute();
    await app.detectStalls.execute();

    const warnings = systemTexts(app, seeded.thread.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('waiting 12 min for your answer on Bash');
  });
});

describe('EnforceTaskTimeouts', () => {
  it('stops and fails a task whose worker used up the time budget, with a report (WRK-11)', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    app.artifacts.write(seeded.task.id, 'spec.md', 's');
    await runningWorker(app, seeded);

    app.clock.advanceMinutes(59);
    await app.enforceTaskTimeouts.execute();
    expect(app.task(seeded.task.id).stage).toBe('Implementing');

    app.clock.advanceMinutes(1);
    await app.enforceTaskTimeouts.execute();

    expect(app.task(seeded.task.id)).toMatchObject({
      stage: 'Failed',
      resumeStage: 'Implementing',
      reason: 'Time limit reached: 60 of 60 active worker minutes used',
    });
    expect(app.runs.calls).toContainEqual({ type: 'stop_task_runs', taskId: seeded.task.id });
    expect(systemTexts(app, seeded.thread.id).at(-1)).toBe(
      [
        `Task ${seeded.task.id} failed. Time limit reached: 60 of 60 active worker minutes used.`,
        'Done so far: reached stage Implementing; wrote spec.md.',
        'Open question: retry with a fresh time budget, or cancel the task?',
      ].join('\n'),
    );
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      actor: 'system',
      data: { to: 'Failed', cause: 'task_timeout' },
    });
  });

  it('adds the earlier runs of the task to the live one', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    const first = await runningWorker(app, seeded, 'r-old');
    app.clock.advanceMinutes(40);
    await app.uow.run((tx) =>
      tx.runs.save({ ...first, status: 'completed', finishedAt: app.clock.now() }),
    );
    await runningWorker(app, seeded, 'r-new');

    app.clock.advanceMinutes(19);
    await app.enforceTaskTimeouts.execute();
    expect(app.task(seeded.task.id).stage).toBe('Implementing');

    app.clock.advanceMinutes(1);
    await app.enforceTaskTimeouts.execute();
    expect(app.task(seeded.task.id).stage).toBe('Failed');
  });

  it('leaves tasks alone that have no running worker', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });

    app.clock.advanceMinutes(600);
    await app.enforceTaskTimeouts.execute();

    expect(app.task(seeded.task.id).stage).toBe('Implementing');
  });
});

describe('activeWorkerMs', () => {
  const at = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 10, minutes)).toISOString();
  const run = (id: string, from: number, to: number | null, role: Run['role'] = 'worker'): Run => ({
    ...startRun({ id, sessionId: 's', role, threadId: 'th', taskId: 'T-1', at: at(from) }),
    ...(to === null ? {} : { status: 'completed' as const, finishedAt: at(to) }),
  });
  const retry = (minutes: number) => ({
    taskId: 'T-1',
    type: 'stage_changed',
    at: at(minutes),
    actor: 'owner' as const,
    data: { from: 'Failed', to: 'Implementing', cause: 'owner_retry', reason: null },
  });

  it('sums finished runs and counts the live one up to now', () => {
    const runs = [run('a', 0, 10), run('b', 20, 25), run('c', 30, null)];
    expect(activeWorkerMs(runs, [], at(42))).toBe((10 + 5 + 12) * 60_000);
  });

  it('starts over at the last owner retry and ignores dispatcher runs', () => {
    const runs = [run('a', 0, 50), run('b', 60, 70), run('d', 61, 69, 'dispatcher')];
    expect(activeWorkerMs(runs, [retry(55)], at(80))).toBe(10 * 60_000);
  });
});

describe('PostProgressUpdates', () => {
  it('reports what a live run is doing, once per interval', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    const run = await runningWorker(app, seeded);
    await app.uow.run((tx) =>
      tx.runs.appendEvent(
        run.id,
        {
          kind: 'tool_use',
          payload: { toolUseId: 't1', name: 'Bash', input: { command: 'npm run lint' } },
        },
        app.clock.now(),
      ),
    );

    await app.postProgressUpdates.execute();
    expect(systemTexts(app, seeded.thread.id)).toEqual([]);

    app.clock.advanceMinutes(3);
    await app.postProgressUpdates.execute();
    await app.postProgressUpdates.execute();

    expect(systemTexts(app, seeded.thread.id)).toEqual([
      `The worker of ${seeded.task.id} is working — Implementing, 3 min in. Now: Bash: npm run lint.`,
    ]);
  });

  it('stays quiet while the run is stalled or waiting for a permission answer', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    await runningWorker(app, seeded);

    // No events at all: past `stallMinutes`, DetectStalls owns the thread.
    app.clock.advanceMinutes(11);
    await app.postProgressUpdates.execute();
    expect(systemTexts(app, seeded.thread.id)).toEqual([]);
  });
});

describe('ExpireOrphanedPermissions', () => {
  it('denies requests whose run is gone, before their deadline', async () => {
    const app = buildTestApp();
    const seeded = await app.seed.task({ stage: 'Implementing' });
    await app.requestPermission.execute(app.identity.worker(seeded.task), {
      tool_name: 'Bash',
      input: {},
    });

    const expired = await app.expireOrphanedPermissions.execute();

    expect(expired).toBe(1);
    const request = app.db.tables.permissions.get('p-1');
    expect(request).toMatchObject({ status: 'timeout' });
    expect(Date.parse(request?.expiresAt ?? '')).toBeGreaterThan(Date.parse(app.clock.now()));
    const card = app.messagesOf(seeded.thread.id).find((m) => m.kind === 'permission');
    expect(card?.answer).toEqual({ decision: 'deny' });
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      type: 'permission_timeout',
      data: { reason: 'run_ended' },
    });
    expect(await app.expireOrphanedPermissions.execute()).toBe(0);
  });
});
