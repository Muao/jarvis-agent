import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../domain/index.js';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { buildTestApp, createTaskInNewThread, type TestApp } from '../testing/index.js';

afterEach(() => {
  vi.useRealTimers();
});

const request = { tool_name: 'Bash', input: { command: 'rm -rf build' } };

async function workerWithRun(app: TestApp) {
  const { taskId, thread } = await createTaskInNewThread(app);
  const token = app.runner.forTask(taskId)?.spec.runToken ?? '';
  return { taskId, thread, identity: app.resolveRunIdentity.execute(token) };
}

describe('permission requests (SLK-05)', () => {
  it('posts a card in the task thread, saves a pending request and journals it', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId, thread, identity } = await workerWithRun(app);
    app.config.set({
      ...app.config.current(),
      limits: { ...app.config.current().limits, permissionTimeoutMinutes: 10 },
    });

    const id = await app.requestPermission.execute(identity, request);

    const saved = app.db.tables.permissions.get(id);
    expect(saved).toMatchObject({
      status: 'pending',
      runId: identity.runId,
      taskId,
      threadId: thread.id,
      tool: 'Bash',
      input: request.input,
      requestedAt: app.clock.now(),
      expiresAt: '2026-01-01T10:10:00.000Z',
    });
    const card = app.messagesOf(thread.id).find((m) => m.kind === 'permission');
    expect(card).toMatchObject({
      taskId,
      body: {
        permissionId: id,
        requester: `worker ${taskId}`,
        toolName: 'Bash',
        input: request.input,
      },
    });
    expect(app.owner.delivered.map((m) => m.id)).toContain(card?.id);
    expect(app.db.tables.journal).toContainEqual(
      expect.objectContaining({ taskId, type: 'permission_requested', actor: 'agent' }),
    );
    expect(app.db.tables.runEvents.get(identity.runId)?.at(-1)).toMatchObject({
      kind: 'permission',
      payload: { permissionId: id, toolName: 'Bash', decision: 'pending' },
    });
  });

  it('asks in the thread for a dispatcher run, without a task', async () => {
    const app = buildTestApp({ realRuns: true });
    const posted = await app.postOwnerMessage.execute({ text: 'hi' });
    const token = app.runner.forThread(posted.threadId, 'dispatcher')?.spec.runToken ?? '';

    const id = await app.requestPermission.execute(app.resolveRunIdentity.execute(token), request);

    expect(app.db.tables.permissions.get(id)).toMatchObject({
      taskId: null,
      threadId: posted.threadId,
    });
    expect(app.messagesOf(posted.threadId).find((m) => m.kind === 'permission')).toMatchObject({
      taskId: null,
      body: { requester: 'dispatcher' },
    });
  });

  it('refuses a run whose task is finished', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId, identity } = await workerWithRun(app);
    await app.cancelTask.execute({ taskId });

    await expect(app.requestPermission.execute(identity, request)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('answering and awaiting', () => {
  it('allow wakes the waiter with the original input', async () => {
    const app = buildTestApp({ realRuns: true });
    const { taskId, thread, identity } = await workerWithRun(app);
    const id = await app.requestPermission.execute(identity, request);

    const pending = app.awaitPermission.execute(id);
    await app.answerPermission.execute(id, 'allow');

    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: request.input });
    const card = app.messagesOf(thread.id).find((m) => m.kind === 'permission');
    expect(card).toMatchObject({ answer: { decision: 'allow' } });
    expect(card?.answeredAt).not.toBeNull();
    expect(app.db.tables.journal).toContainEqual(
      expect.objectContaining({
        taskId,
        type: 'permission_answered',
        actor: 'owner',
        data: expect.objectContaining({ decision: 'allow' }),
      }),
    );
    expect(app.owner.updates.map((m) => m.id)).toContain(card?.id);
    const lifecycle = app.logger.infos.filter((i) =>
      String(i.context['event']).startsWith('permission.'),
    );
    expect(lifecycle.map((i) => i.context['event'])).toEqual([
      'permission.requested',
      'permission.answered',
    ]);
    expect(lifecycle[1]?.context).toMatchObject({ runId: identity.runId, taskId });
    expect(app.db.tables.runEvents.get(identity.runId)?.at(-1)).toMatchObject({
      payload: { decision: 'allow' },
    });
  });

  it('deny wakes the waiter with a deny', async () => {
    const app = buildTestApp({ realRuns: true });
    const { identity } = await workerWithRun(app);
    const id = await app.requestPermission.execute(identity, request);

    const pending = app.awaitPermission.execute(id);
    await app.answerPermission.execute(id, 'deny');

    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('returns at once when the request was decided before the wait began', async () => {
    const app = buildTestApp({ realRuns: true });
    const { identity } = await workerWithRun(app);
    const id = await app.requestPermission.execute(identity, request);
    await app.answerPermission.execute(id, 'allow');

    await expect(app.awaitPermission.execute(id)).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('wakes every caller waiting on the same request', async () => {
    const app = buildTestApp({ realRuns: true });
    const { identity } = await workerWithRun(app);
    const id = await app.requestPermission.execute(identity, request);

    const waiting = [app.awaitPermission.execute(id), app.awaitPermission.execute(id)];
    await app.answerPermission.execute(id, 'deny');

    await expect(Promise.all(waiting)).resolves.toHaveLength(2);
  });

  it('rejects a second answer and keeps the first', async () => {
    const app = buildTestApp({ realRuns: true });
    const { identity } = await workerWithRun(app);
    const id = await app.requestPermission.execute(identity, request);
    await app.answerPermission.execute(id, 'deny');

    await expect(app.answerPermission.execute(id, 'allow')).rejects.toMatchObject({
      code: 'already_decided',
    });
    expect(app.db.tables.permissions.get(id)?.status).toBe('deny');
  });

  it('rejects an unknown request', async () => {
    const app = buildTestApp({ realRuns: true });

    await expect(app.answerPermission.execute('p-9', 'allow')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(app.awaitPermission.execute('p-9')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('timeout (SLK-05)', () => {
  it('denies an unanswered request when it expires and journals it', async () => {
    vi.useFakeTimers();
    const app = buildTestApp({ realRuns: true });
    const { taskId, thread, identity } = await workerWithRun(app);
    const id = await app.requestPermission.execute(identity, request);

    const pending = app.awaitPermission.execute(id);
    app.clock.advanceMinutes(30);
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000);

    const result = await pending;
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(app.db.tables.permissions.get(id)).toMatchObject({ status: 'timeout' });
    expect(app.db.tables.journal).toContainEqual(
      expect.objectContaining({ taskId, type: 'permission_timeout', actor: 'system' }),
    );
    expect(app.messagesOf(thread.id).find((m) => m.kind === 'permission')?.answer).toEqual({
      decision: 'deny',
      reason: 'timeout',
    });
    expect(app.db.tables.runEvents.get(identity.runId)?.at(-1)).toMatchObject({
      payload: { decision: 'timeout' },
    });
  });

  it('cannot be allowed after it expired', async () => {
    const app = buildTestApp({ realRuns: true });
    const { identity } = await workerWithRun(app);
    const id = await app.requestPermission.execute(identity, request);

    app.clock.advanceMinutes(31);

    await expect(app.answerPermission.execute(id, 'allow')).rejects.toBeInstanceOf(DomainError);
    expect(app.db.tables.permissions.get(id)?.status).toBe('pending');
  });

  it('expires a request on demand only when it is due', async () => {
    const app = buildTestApp({ realRuns: true });
    const { identity } = await workerWithRun(app);
    const id = await app.requestPermission.execute(identity, request);

    await app.expirePermission.execute(id);
    expect(app.db.tables.permissions.get(id)?.status).toBe('pending');

    app.clock.advanceMinutes(30);
    await app.expirePermission.execute(id);
    expect(app.db.tables.permissions.get(id)?.status).toBe('timeout');
  });
});
