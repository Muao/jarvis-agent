import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../domain/index.js';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { buildTestApp, createTaskInNewThread, systemTexts } from '../testing/index.js';

const app = () => buildTestApp({ realRuns: true });

describe('first message of a worker run ("Run context")', () => {
  it('carries the context block, USER.md and the task description', async () => {
    const a = app();
    a.profile.text = 'Reply in Ukrainian.';

    const { taskId } = await createTaskInNewThread(a, { description: 'Add /health.\nSee ADR-3.' });

    const spec = a.runner.forTask(taskId)?.spec;
    expect(spec?.firstMessage).toBe(
      [
        '## Run context',
        'taskId: T-1',
        'branch: jarvis/T-1',
        'artifactsDir: /jarvis/tasks/T-1',
        'stage: Context',
        'taskKind: build',
        'uiCheck: available',
        '## Owner preferences (USER.md)',
        'Reply in Ukrainian.',
        '## Task description',
        'Add /health.\nSee ADR-3.',
      ].join('\n'),
    );
    expect(spec).toMatchObject({
      role: 'worker',
      cwd: '/jarvis/worktrees/T-1',
      model: 'sonnet',
      maxTurns: 60,
      maxBudgetUsd: 3,
      keepStdinOpen: true,
      taskId: 'T-1',
      screenshotsDir: '/jarvis/tasks/T-1/screenshots',
    });
    expect(spec?.resumeSessionId).toBeUndefined();
  });

  it('moves the task out of Intake with a journal event on its first run only', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);

    expect(a.task(taskId).stage).toBe('Context');
    const moves = a.db.tables.journal.filter((e) => e.type === 'stage_changed');
    expect(moves).toMatchObject([
      { taskId, data: { from: 'Intake', to: 'Context', cause: 'worker_started' } },
    ]);

    await a.runner.forTask(taskId)?.succeed();
    await a.scheduler.requestWorkerRun(taskId);
    expect(a.db.tables.journal.filter((e) => e.type === 'stage_changed')).toHaveLength(1);
  });

  it('logs one info line each for run start, stage change and run finish', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    await a.runner.forTask(taskId)?.succeed();

    const events = a.logger.infos.map((i) => i.context['event']);
    expect(events).toEqual(['task.stage', 'run.started', 'run.finished']);
    const [stage, started, finished] = a.logger.infos;
    const run = [...a.db.tables.runs.values()].find((r) => r.taskId === taskId);
    expect(run).toBeDefined();
    expect(stage?.context).toEqual({
      event: 'task.stage',
      taskId,
      threadId: run?.threadId,
    });
    expect(started?.context).toEqual({
      event: 'run.started',
      runId: run?.id,
      sessionId: run?.sessionId,
      taskId,
      threadId: run?.threadId,
      role: 'worker',
      model: 'sonnet',
    });
    expect(finished?.context).toEqual({
      event: 'run.finished',
      runId: run?.id,
      sessionId: run?.sessionId,
      taskId,
      threadId: run?.threadId,
      role: 'worker',
      costUsd: run?.costUsd,
      turns: run?.turns,
      durationMs: Date.parse(run?.finishedAt ?? '') - Date.parse(run?.startedAt ?? ''),
    });
  });

  it('reads USER.md fresh for every run and delivers pending owner messages exactly once', async () => {
    const a = app();
    a.profile.text = 'Be verbose.';
    const { taskId, thread } = await createTaskInNewThread(a);
    await a.runner.forTask(taskId)?.reportSession('claude-1');
    await a.runner.forTask(taskId)?.succeed();

    a.profile.text = 'Be brief.';
    // With no worker live the message starts the run that will read it.
    const posted = await a.postOwnerMessage.execute({ threadId: thread.id, text: 'use port 4000' });

    const second = a.runner.processes[1]?.spec.firstMessage;
    expect(second).toContain('Be brief.');
    expect(second).not.toContain('Be verbose.');
    expect(second).toContain('## Pending owner messages\n- use port 4000');
    expect(second).not.toContain('## Task description');
    expect(a.message(posted.messageId).body).toMatchObject({ delivery: 'delivered' });

    await a.runner.processes[1]?.succeed();
    await a.scheduler.requestWorkerRun(taskId);
    expect(a.runner.processes[2]?.spec.firstMessage).not.toContain('Pending owner messages');
  });

  it('omits sections that have nothing to say', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    expect(a.runner.forTask(taskId)?.spec.firstMessage).not.toContain('USER.md');
  });

  it('keeps the task description for a session that never reported its id', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a, { description: 'Do the thing.' });
    await a.runner.forTask(taskId)?.exit({ type: 'exit', code: 1 });

    await a.scheduler.requestWorkerRun(taskId);

    expect(a.runner.processes[1]?.spec.firstMessage).toContain('Do the thing.');
  });
});

describe('sessions and events', () => {
  it('stores the CLI session id and resumes it on the next run', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const first = a.runner.forTask(taskId);
    await first?.reportSession('claude-abc');
    await first?.succeed();

    await a.scheduler.requestWorkerRun(taskId);

    const sessionId = a.task(taskId).workerSessionId;
    expect(sessionId).toBe('s-1');
    expect(a.db.tables.sessions.get('s-1')).toMatchObject({
      role: 'worker',
      taskId,
      claudeSessionId: 'claude-abc',
    });
    expect(a.runner.processes[1]?.spec.resumeSessionId).toBe('claude-abc');
    expect(a.runner.processes[1]?.spec.runId).not.toBe(first?.spec.runId);
    const runs = await a.uow.run((tx) => tx.runs.listByTask(taskId));
    expect(runs.map((r) => [r.sessionId, r.status])).toEqual([
      ['s-1', 'completed'],
      ['s-1', 'running'],
    ]);
  });

  it('stores each event under the next seq and publishes it', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const process = a.runner.forTask(taskId);
    await process?.emit({ kind: 'text', payload: { text: 'hello' } });
    await process?.emit({ kind: 'system', payload: { subtype: 'init' } });

    const stored = a.db.tables.runEvents.get(process?.spec.runId ?? '');
    expect(stored?.map((e) => e.seq)).toEqual([0, 1]);
    expect(stored?.[0]).toMatchObject({ runId: 'r-1', kind: 'text', payload: { text: 'hello' } });
    expect(a.events.published).toContainEqual({ type: 'run_event', id: 'r-1', data: stored?.[0] });
  });

  it('logs a failure while handling the runner and does not throw it back', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    vi.spyOn(a.events, 'publish').mockRejectedValue(new Error('bus down'));

    await expect(
      a.runner.forTask(taskId)?.emit({ kind: 'text', payload: { text: 'x' } }),
    ).resolves.toBeUndefined();

    expect(a.logger.entries.at(-1)).toMatchObject({
      level: 'error',
      message: 'run event handling failed',
      context: { error: 'bus down' },
    });
  });
});

describe('run exit', () => {
  const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  const result = (subtype: string) =>
    ({ type: 'result', subtype, costUsd: 0.5, turns: 4, usage }) as const;

  it.each([
    ['success', result('success'), 'completed'],
    ['max turns', result('error_max_turns'), 'limit_reached'],
    ['max budget', result('error_max_budget_usd'), 'limit_reached'],
    ['execution error', result('error_during_execution'), 'failed'],
    ['no result line', { type: 'exit', code: 2 } as const, 'failed'],
    ['subscription limit', { type: 'rate_limited' } as const, 'limit_reached'],
    ['stopped', { type: 'stopped' } as const, 'stopped'],
  ] as const)('%s ends the run as %s', async (_name, outcome, status) => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);

    await a.runner.forTask(taskId)?.exit(outcome);

    const run = a.db.tables.runs.get('r-1');
    expect(run).toMatchObject({ status });
    expect(run?.finishedAt).not.toBeNull();
    if (outcome.type === 'result') expect(run).toMatchObject({ costUsd: 0.5, turns: 4, usage });
    expect(a.events.published).toContainEqual({ type: 'run', id: 'r-1' });
  });

  it('tells the thread when a run stopped at its limit', async () => {
    const a = app();
    const { taskId, thread } = await createTaskInNewThread(a);

    await a.runner.forTask(taskId)?.exit(result('error_max_turns'));

    expect(systemTexts(a, thread.id)).toEqual([
      'The worker of T-1 started — Context.',
      'Run stopped at its limit: max turns reached.',
    ]);
  });

  it('tells the thread why a run failed', async () => {
    const a = app();
    const { taskId, thread } = await createTaskInNewThread(a);

    await a.runner
      .forTask(taskId)
      ?.exit({ type: 'exit', code: 1, message: 'claude exited with code 1: not logged in' });

    expect(systemTexts(a, thread.id)).toEqual([
      'The worker of T-1 started — Context.',
      'The worker run of T-1 failed: claude exited with code 1: not logged in',
    ]);
  });

  it('forgets the run token', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const process = a.runner.forTask(taskId);
    const token = process?.spec.runToken ?? '';

    expect(a.resolveRunIdentity.execute(token)).toEqual({
      runId: 'r-1',
      role: 'worker',
      threadId: a.task(taskId).threadId,
      taskId,
    });
    await process?.succeed();

    expect(() => a.resolveRunIdentity.execute(token)).toThrow(ForbiddenError);
    expect(() => a.resolveRunIdentity.execute('made-up')).toThrow(ForbiddenError);
  });

  it('gives every run its own token and identifies a dispatcher without a task', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const posted = await a.postOwnerMessage.execute({ text: 'hi' });

    const worker = a.runner.forTask(taskId)?.spec.runToken ?? '';
    const dispatcher = a.runner.forThread(posted.threadId, 'dispatcher')?.spec.runToken ?? '';

    expect(worker).not.toBe(dispatcher);
    expect(a.resolveRunIdentity.execute(dispatcher)).toEqual({
      runId: 'r-2',
      role: 'dispatcher',
      threadId: posted.threadId,
    });
  });

  it('ignores a second exit', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const process = a.runner.forTask(taskId);
    await process?.succeed(1);
    await process?.exit({ type: 'stopped' });

    expect(a.db.tables.runs.get('r-1')).toMatchObject({ status: 'completed', costUsd: 1 });
  });
});

describe('StopRun (ADM-06)', () => {
  it('stops the process and journals the owner action', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);

    await a.stopRun.execute('r-1');

    expect(a.runner.forTask(taskId)?.stopped).toBe(true);
    expect(a.db.tables.runs.get('r-1')).toMatchObject({ status: 'stopped' });
    expect(a.db.tables.journal).toContainEqual(
      expect.objectContaining({
        taskId,
        type: 'run_stopped',
        actor: 'owner',
        data: { runId: 'r-1' },
      }),
    );
  });

  it('starts the next queued task once the slot is free', async () => {
    const a = app();
    await createTaskInNewThread(a);
    const second = await createTaskInNewThread(a);

    await a.stopRun.execute('r-1');

    expect(a.runner.live.map((p) => p.spec.taskId)).toEqual([second.taskId]);
  });

  it('rejects a finished run and an unknown run', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    await a.runner.forTask(taskId)?.succeed();

    await expect(a.stopRun.execute('r-1')).rejects.toBeInstanceOf(DomainError);
    await expect(a.stopRun.execute('r-99')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('owner input to a live worker (DSP-04, ADM-06)', () => {
  it('writes it to the live process and marks it delivered', async () => {
    const a = app();
    const { taskId, thread } = await createTaskInNewThread(a);

    const posted = await a.postOwnerMessage.execute({ threadId: thread.id, text: 'use port 4000' });

    expect(a.runner.forTask(taskId)?.sent).toEqual(['use port 4000']);
    expect(a.message(posted.messageId).body).toMatchObject({ delivery: 'delivered' });
    expect(a.owner.updates.at(-1)?.id).toBe(posted.messageId);
  });

  // DSP-04 promises the reply reaches the worker "in the next run", but for a task parked in a
  // stage nobody watches there is no next run: the message used to wait for ever and the owner got
  // silence (T-4 sat in Reviewing while an owner message went undelivered). The input starts one.
  it('starts a run for the task when no worker is live, and delivers it there', async () => {
    const a = app();
    const { taskId, thread } = await createTaskInNewThread(a);
    await a.runner.forTask(taskId)?.succeed();
    expect(a.runner.processes).toHaveLength(1);

    const posted = await a.postOwnerMessage.execute({ threadId: thread.id, text: 'later' });

    // The run reads it on the way in, so it arrives in the first message, not through `send`.
    expect(a.runner.processes).toHaveLength(2);
    expect(a.runner.processes[1]?.spec.taskId).toBe(taskId);
    expect(a.runner.processes[1]?.spec.firstMessage).toContain('- later');
    expect(a.message(posted.messageId).body).toMatchObject({ delivery: 'delivered' });
  });

  it('starts nothing when there is no owner input waiting', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    await a.runner.forTask(taskId)?.succeed();
    const runs = a.runner.processes.length;

    await a.scheduler.deliverToWorker(taskId);

    expect(a.runner.processes).toHaveLength(runs);
  });

  it('sends a console message to the session of the task', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const sessionId = a.task(taskId).workerSessionId ?? '';

    await expect(a.sendToSession.execute(sessionId, 'check the tests')).resolves.toBe('delivered');
    expect(a.runner.forTask(taskId)?.sent).toEqual(['check the tests']);
    expect(a.db.tables.journal).toContainEqual(
      expect.objectContaining({
        type: 'owner_input',
        actor: 'owner',
        data: expect.objectContaining({ via: 'console' }),
      }),
    );

    await a.runner.forTask(taskId)?.succeed();
    // No live run: the message starts one rather than waiting for a run nobody would ask for,
    // and the new run reads it from its first message.
    await expect(a.sendToSession.execute(sessionId, 'and again')).resolves.toBe('delivered');
    expect(a.runner.processes[1]?.spec.firstMessage).toContain('- and again');
  });

  it('refuses a console message for a finished task or an unknown session', async () => {
    const a = app();
    const { taskId } = await createTaskInNewThread(a);
    const sessionId = a.task(taskId).workerSessionId ?? '';
    await a.cancelTask.execute({ taskId });

    await expect(a.sendToSession.execute(sessionId, 'x')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(a.sendToSession.execute('s-99', 'x')).rejects.toBeInstanceOf(NotFoundError);
  });
});
