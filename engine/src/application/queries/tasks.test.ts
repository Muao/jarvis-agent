import {
  ArtifactDtoSchema,
  RunEventsDtoSchema,
  SessionDtoSchema,
  TaskDetailDtoSchema,
  TaskDtoSchema,
} from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NotFoundError } from '../errors.js';
import {
  FLOW_PR as PR,
  buildTestApp,
  createTaskInNewThread,
  identityOfProcess,
  taskInPrOpen,
} from '../testing/index.js';

describe('GetTasks', () => {
  it('lists tasks newest first with what they wait for, CI, runs and cost', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await taskInPrOpen(app);
    app.clock.advanceMinutes(1);
    const { task: reviewing } = await app.seed.task({ stage: 'Spec Review' });

    const rows = z.array(TaskDtoSchema).parse(await app.getTasks.execute());

    expect(rows.map((r) => r.id)).toEqual([reviewing.id, taskId]);
    expect(rows[0]).toMatchObject({
      stage: 'Spec Review',
      waitingFor: 'owner',
      ci: null,
      prNumber: null,
      runCount: 0,
      costUsd: 0,
    });
    expect(rows[1]).toMatchObject({
      id: taskId,
      stage: 'PR Open',
      waitingFor: 'ci',
      ci: 'running',
      prNumber: 7,
      prUrl: PR.url,
      branch: 'jarvis/T-1',
      runCount: 2,
      costUsd: 0.5,
    });
  });

  it('says review once CI is green, and worker slot while the task waits for one', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await taskInPrOpen(app);
    app.codeHost.set(PR.number, {
      headSha: 'abcdef1234567',
      checks: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }],
      reviews: [],
      comments: [],
    });
    await app.pollPullRequests.execute();
    expect(await app.getTasks.execute()).toMatchObject([
      { id: taskId, waitingFor: 'review', ci: 'passed' },
    ]);

    const second = await createTaskInNewThread(app);
    // Run 2 of the first task still holds the only worker slot.
    expect((await app.getTasks.execute()).find((t) => t.id === second.taskId)).toMatchObject({
      waitingFor: 'worker slot',
    });
  });
});

describe('GetTask', () => {
  it('fills every block of Task detail from the journal, the watch and the runs', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await taskInPrOpen(app);

    const detail = TaskDetailDtoSchema.parse(await app.getTask.execute(taskId));

    expect(detail).toMatchObject({
      id: taskId,
      stage: 'PR Open',
      waitingFor: 'ci',
      reason: null,
      workerSessionId: 's-1',
      counters: {
        // A red gate used one retry; the green one that opened the PR reset it (ADR-0022).
        checks: { used: 0, max: 3 },
        ciFixes: { used: 0, max: 2 },
        reviews: { used: 0, max: 3 },
      },
    });
    expect(detail.stages.map((s) => s.stage)).toEqual([
      'Intake',
      'Context',
      'Spec Review',
      'Implementing',
      'Verifying',
      'Implementing',
      'Verifying',
      'PR Open',
    ]);
    expect(detail.stages.map((s) => s.exitedAt === null)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(detail.pullRequest).toMatchObject({
      number: 7,
      url: PR.url,
      headSha: 'abcdef1234567',
      review: 'pending',
      checks: [
        { name: 'build', status: 'passed', url: 'https://ci/1' },
        { name: 'lint', status: 'running', url: null },
      ],
      earlierChecks: [],
      comments: [],
    });
    expect(detail.pullRequest?.lastCheckedAt).not.toBeNull();
    expect(detail.runs).toMatchObject([
      {
        id: 'r-1',
        sessionId: 's-1',
        role: 'worker',
        stage: 'Context',
        status: 'completed',
        costUsd: 0.5,
        maxTurns: 60,
      },
      { id: 'r-2', sessionId: 's-1', stage: 'Implementing', status: 'running' },
    ]);
    expect(detail.artifacts).toEqual([
      { name: 'context.md', exists: false },
      { name: 'spec.md', exists: true },
      { name: 'plan.md', exists: true },
      { name: 'tasks.md', exists: false },
      { name: 'result.md', exists: false },
    ]);
  });

  it('writes a readable sentence and the actor for every journal entry', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await taskInPrOpen(app);

    const { journal } = await app.getTask.execute(taskId);

    const lines = journal.map((e) => `${e.by}: ${e.text}`);
    expect(lines).toEqual(
      expect.arrayContaining([
        'agent: Task created: Add endpoint',
        'system: Stage: Intake → Context',
        'system: Worker session created',
        'agent: Stage: Context → Spec Review',
        'owner: Stage: Spec Review → Implementing',
        'agent: Checks declared: `pnpm test`, `pnpm typecheck`',
        "owner: Checks fixed by the owner's approval: `pnpm test`, `pnpm typecheck`",
        'system: Stage: Implementing → Verifying',
        'system: Checks failed on a1b2c3d (attempt 1/3) — pnpm test',
        'system: Stage: Verifying → Implementing',
        'system: Checks passed on a1b2c3d',
        'system: Branch jarvis/T-1 pushed at a1b2c3d',
        'system: Stage: Verifying → PR Open',
        `system: Draft PR #7 opened: ${PR.url}`,
      ]),
    );
    expect(new Set(journal.map((e) => e.id)).size).toBe(journal.length);
    expect(journal.every((e) => e.text !== '')).toBe(true);
  });

  it('gives the reason of a block and of a cancellation on the matching stage span', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app);
    const identity = identityOfProcess(app, 0);
    await app.askOwner.execute(identity, { question: 'Which database?' });
    expect(await app.getTask.execute(taskId)).toMatchObject({
      stage: 'Blocked',
      reason: 'Which database?',
      waitingFor: 'owner',
    });

    await app.cancelTask.execute({ taskId, reason: 'not needed' });
    const detail = TaskDetailDtoSchema.parse(await app.getTask.execute(taskId));
    expect(detail.stages.map((s) => [s.stage, s.reason])).toEqual([
      ['Intake', null],
      ['Context', null],
      ['Blocked', 'Which database?'],
      ['Cancelled', 'not needed'],
    ]);
    expect(detail).toMatchObject({ stage: 'Cancelled', waitingFor: '—', reason: 'not needed' });
  });

  it('rejects an unknown task', async () => {
    await expect(buildTestApp().getTask.execute('T-9')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('GetArtifact', () => {
  it('returns the content and time of a written file, and exists: false for the rest', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task();
    app.artifacts.write(task.id, 'spec.md', '# Spec\n- [ ] one');

    const spec = ArtifactDtoSchema.parse(await app.getArtifact.execute(task.id, 'spec.md'));
    expect(spec).toEqual({
      name: 'spec.md',
      exists: true,
      content: '# Spec\n- [ ] one',
      updatedAt: app.clock.now(),
    });
    expect(ArtifactDtoSchema.parse(await app.getArtifact.execute(task.id, 'plan.md'))).toEqual({
      name: 'plan.md',
      exists: false,
      content: null,
      updatedAt: null,
    });
  });

  it('rejects an unknown task', async () => {
    await expect(buildTestApp().getArtifact.execute('T-9', 'spec.md')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('GetSession / GetRunEvents', () => {
  it('shows the worker session with its runs and a running status', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await taskInPrOpen(app);

    const session = SessionDtoSchema.parse(await app.getSession.execute('s-1'));

    expect(session).toMatchObject({
      id: 's-1',
      role: 'worker',
      taskId,
      model: 'sonnet',
      status: 'running',
      claudeSessionId: 'claude-1',
      stalled: false,
    });
    expect(session.runs.map((r) => [r.id, r.status])).toEqual([
      ['r-1', 'completed'],
      ['r-2', 'running'],
    ]);
  });

  it('flags a silent run as stalled and a run waiting for the owner as waiting_for_permission', async () => {
    const app = buildTestApp({ realRuns: true });
    const { worker } = await taskInPrOpen(app);

    app.clock.advanceMinutes(10);
    expect(await app.getSession.execute('s-1')).toMatchObject({ status: 'running', stalled: true });

    await app.requestPermission.execute(worker, { tool_name: 'Bash', input: { command: 'ls' } });
    expect(await app.getSession.execute('s-1')).toMatchObject({
      status: 'waiting_for_permission',
    });
  });

  it('reports an ended session as idle, stopped or error from its last run', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app);
    await app.runner.processes[0]?.succeed();
    expect(await app.getSession.execute('s-1')).toMatchObject({ status: 'idle', stalled: false });

    await app.scheduler.requestWorkerRun(taskId);
    await app.runner.processes[1]?.exit({ type: 'exit', code: 1 });
    expect(await app.getSession.execute('s-1')).toMatchObject({ status: 'error' });
  });

  it('returns a dispatcher session without a task or a stage', async () => {
    const app = buildTestApp({ realRuns: true });
    const thread = await app.seed.thread();
    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'hello' });

    const session = SessionDtoSchema.parse(await app.getSession.execute('s-1'));
    expect(session).toMatchObject({ role: 'dispatcher', taskId: null, threadId: thread.id });
    expect(session.runs[0]).toMatchObject({ taskId: null, stage: null, role: 'dispatcher' });
  });

  it('returns a run’s events in order, only those after afterSeq when asked', async () => {
    const app = buildTestApp({ realRuns: true });
    await taskInPrOpen(app);

    const all = RunEventsDtoSchema.parse(await app.getRunEvents.execute('r-1'));
    expect(all.events.map((e) => e.seq)).toEqual(all.events.map((_, index) => index));
    expect(all.events.slice(0, 2).map((e) => e.kind)).toEqual(['tool_use', 'tool_result']);

    const later = await app.getRunEvents.execute('r-1', 0);
    expect(later.events.map((e) => e.seq)).toEqual(all.events.slice(1).map((e) => e.seq));
    expect((await app.getRunEvents.execute('r-1', all.events.length)).events).toEqual([]);
  });

  it('rejects an unknown session or run', async () => {
    const app = buildTestApp();
    await expect(app.getSession.execute('s-9')).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.getRunEvents.execute('r-9')).rejects.toBeInstanceOf(NotFoundError);
  });
});
