import {
  ArtifactDtoSchema,
  ConfigDtoSchema,
  HealthSchema,
  ConnectionsDtoSchema,
  OverviewDtoSchema,
  SendSessionMessageResultSchema,
  TaskDetailDtoSchema,
  TaskDtoSchema,
  ThreadDetailDtoSchema,
  ThreadDtoSchema,
  UsageDtoSchema,
  UsageReportSchema,
} from '@jarvis/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildTestApp,
  createTaskInNewThread,
  type TestApp,
} from '../../application/testing/index.js';
import { SseHub } from '../../infrastructure/sse/sse-hub.js';
import { buildServer } from './server.js';

const servers: FastifyInstance[] = [];

function start(options: { realRuns?: boolean } = {}): { app: TestApp; http: FastifyInstance } {
  const app = buildTestApp(options);
  const http = buildServer(app, { stream: new SseHub() });
  servers.push(http);
  return { app, http };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function taskInSpecReview(app: TestApp) {
  const seeded = await app.seed.task({ stage: 'Context' });
  app.artifacts.write(seeded.task.id, 'spec.md', '# spec');
  app.artifacts.write(seeded.task.id, 'plan.md', '# plan');
  const { cardId } = await app.submitSpec.execute(app.identity.worker(seeded.task), {
    summary: 'Add /health',
  });
  return { ...seeded, cardId };
}

describe('threads', () => {
  it('POST /api/threads opens a thread with the first message and returns the detail', async () => {
    const { http, app } = start();

    const res = await http.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { text: 'Add a page' },
    });

    expect(res.statusCode).toBe(201);
    const thread = ThreadDetailDtoSchema.parse(res.json());
    expect(thread.title).toBe('Add a page');
    expect(thread.messages.map((m) => m.kind)).toEqual(['owner']);
    expect(app.runs.calls).toEqual([{ type: 'dispatcher_turn', threadId: thread.id }]);
  });

  it.each([
    ['empty text', { text: '' }],
    ['missing text', {}],
    ['an unknown field', { text: 'x', taskId: 'T-1' }],
  ])('POST /api/threads rejects %s with 400 and the offending path', async (_name, payload) => {
    const { http } = start();

    const res = await http.inject({ method: 'POST', url: '/api/threads', payload });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
    expect(res.json().details.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON with 400', async () => {
    const { http } = start();

    const res = await http.inject({
      method: 'POST',
      url: '/api/threads',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'bad_request' });
  });

  it('lists threads as a plain array and reads one', async () => {
    const { http, app } = start();
    const thread = await app.seed.thread('Hello');

    const list = await http.inject({ method: 'GET', url: '/api/threads' });
    const one = await http.inject({ method: 'GET', url: `/api/threads/${thread.id}` });

    expect(z.array(ThreadDtoSchema).parse(list.json())).toHaveLength(1);
    expect(ThreadDetailDtoSchema.parse(one.json()).id).toBe(thread.id);
  });

  it('answers 404 for an unknown thread, on read and on post', async () => {
    const { http } = start();

    const read = await http.inject({ method: 'GET', url: '/api/threads/nope' });
    const post = await http.inject({
      method: 'POST',
      url: '/api/threads/nope/messages',
      payload: { text: 'hi' },
    });

    expect(read.statusCode).toBe(404);
    expect(read.json()).toMatchObject({ code: 'not_found' });
    expect(post.statusCode).toBe(404);
  });

  it('POST /api/threads/:id/messages stores the message and answers 204', async () => {
    const { http, app } = start();
    const thread = await app.seed.thread();

    const res = await http.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: 'next' },
    });

    expect(res.statusCode).toBe(204);
    expect(app.messagesOf(thread.id).map((m) => m.kind)).toEqual(['owner']);
  });

  it('never calls a command from a GET', async () => {
    const { http, app } = start();
    const thread = await app.seed.thread();
    app.clearEffects();

    for (const url of [
      '/api/threads',
      `/api/threads/${thread.id}`,
      '/api/tasks',
      '/api/overview',
    ]) {
      await http.inject({ method: 'GET', url });
    }

    expect(app.runs.calls).toEqual([]);
    expect(app.owner.delivered).toEqual([]);
    expect(app.events.published).toEqual([]);
  });
});

describe('cards', () => {
  it('approves a decision card with 204 and moves the task on', async () => {
    const { http, app } = start();
    const { task, cardId } = await taskInSpecReview(app);

    const res = await http.inject({
      method: 'POST',
      url: `/api/messages/${cardId}/answer`,
      payload: { decision: 'approve' },
    });

    expect(res.statusCode).toBe(204);
    expect(app.task(task.id).stage).toBe('Implementing');
  });

  it('answers 409 with the domain code when the card was already answered', async () => {
    const { http, app } = start();
    const { cardId } = await taskInSpecReview(app);
    const answer = {
      method: 'POST',
      url: `/api/messages/${cardId}/answer`,
      payload: { decision: 'approve' },
    } as const;
    await http.inject(answer);

    const again = await http.inject(answer);

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'already_answered' });
  });

  it('answers 400 when requesting changes without a comment', async () => {
    const { http, app } = start();
    const { cardId } = await taskInSpecReview(app);

    const res = await http.inject({
      method: 'POST',
      url: `/api/messages/${cardId}/answer`,
      payload: { decision: 'request_changes' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_input' });
  });

  it('answers a question card with text', async () => {
    const { http, app } = start();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    const { cardId } = await app.askOwner.execute(app.identity.worker(task), {
      question: 'Which?',
    });

    const res = await http.inject({
      method: 'POST',
      url: `/api/messages/${cardId}/answer`,
      payload: { text: 'The first.' },
    });

    expect(res.statusCode).toBe(204);
    expect(app.task(task.id).stage).toBe('Implementing');
  });

  it('answers 404 for an unknown card and 400 for a body that is no answer', async () => {
    const { http } = start();

    const unknown = await http.inject({
      method: 'POST',
      url: '/api/messages/nope/answer',
      payload: { decision: 'approve' },
    });
    const bad = await http.inject({
      method: 'POST',
      url: '/api/messages/nope/answer',
      payload: { decision: 'maybe' },
    });

    expect(unknown.statusCode).toBe(404);
    expect(bad.statusCode).toBe(400);
  });

  it('answers 404 for an unknown permission and 400 for a bad decision', async () => {
    const { http } = start();

    const unknown = await http.inject({
      method: 'POST',
      url: '/api/permissions/nope',
      payload: { decision: 'allow' },
    });
    const bad = await http.inject({
      method: 'POST',
      url: '/api/permissions/nope',
      payload: { decision: 'always' },
    });

    expect(unknown.statusCode).toBe(404);
    expect(bad.statusCode).toBe(400);
  });
});

describe('tasks', () => {
  it('lists tasks and reads one with its detail', async () => {
    const { http, app } = start();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    const list = await http.inject({ method: 'GET', url: '/api/tasks' });
    const one = await http.inject({ method: 'GET', url: `/api/tasks/${task.id}` });

    expect(z.array(TaskDtoSchema).parse(list.json())).toHaveLength(1);
    expect(TaskDetailDtoSchema.parse(one.json()).id).toBe(task.id);
  });

  it('answers 404 for an unknown task', async () => {
    const { http } = start();

    const res = await http.inject({ method: 'GET', url: '/api/tasks/T-99' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });

  it('serves an artifact, also one that is not written yet, and rejects an unknown name', async () => {
    const { http, app } = start();
    const { task } = await app.seed.task({ stage: 'Context' });
    app.artifacts.write(task.id, 'spec.md', '# spec');

    const written = await http.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/artifacts/spec.md`,
    });
    const missing = await http.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/artifacts/plan.md`,
    });
    const bad = await http.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/artifacts/secrets.txt`,
    });

    expect(ArtifactDtoSchema.parse(written.json())).toMatchObject({
      exists: true,
      content: '# spec',
    });
    expect(ArtifactDtoSchema.parse(missing.json())).toMatchObject({ exists: false, content: null });
    expect(bad.statusCode).toBe(400);
  });

  it('cancels with 204; a second cancel and a retry of a cancelled task are 409', async () => {
    const { http, app } = start();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    const cancel = await http.inject({ method: 'POST', url: `/api/tasks/${task.id}/cancel` });
    const again = await http.inject({ method: 'POST', url: `/api/tasks/${task.id}/cancel` });
    const retry = await http.inject({ method: 'POST', url: `/api/tasks/${task.id}/retry` });

    expect(cancel.statusCode).toBe(204);
    expect(app.task(task.id).stage).toBe('Cancelled');
    expect(again.statusCode).toBe(409);
    expect(retry.statusCode).toBe(409);
  });

  it('answers 404 when cancelling an unknown task', async () => {
    const { http } = start();

    const res = await http.inject({ method: 'POST', url: '/api/tasks/T-99/cancel' });

    expect(res.statusCode).toBe(404);
  });

  it('stops the live worker process; without one the answer is 409', async () => {
    const { http, app } = start({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app);
    const process = app.runner.forTask(taskId);

    const stop = await http.inject({ method: 'POST', url: `/api/tasks/${taskId}/stop` });
    const again = await http.inject({ method: 'POST', url: `/api/tasks/${taskId}/stop` });

    expect(stop.statusCode).toBe(204);
    expect(process?.stopped).toBe(true);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'run_not_running' });
  });
});

describe('sessions and runs', () => {
  it('reads a session, run events and sends a console message', async () => {
    const { http, app } = start({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app);
    const process = app.runner.forTask(taskId);
    await process?.emit({ kind: 'text', payload: { text: 'hello' } });
    const detail = TaskDetailDtoSchema.parse(
      (await http.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json(),
    );
    const sessionId = detail.workerSessionId ?? '';
    const runId = detail.runs[0]?.id ?? '';

    const session = await http.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    const events = await http.inject({
      method: 'GET',
      url: `/api/runs/${runId}/events?afterSeq=-1`,
    });
    const sent = await http.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: 'hurry up' },
    });

    expect(session.json()).toMatchObject({ id: sessionId, role: 'worker' });
    expect(events.json().events).toHaveLength(1);
    expect(SendSessionMessageResultSchema.parse(sent.json())).toEqual({ delivery: 'delivered' });
    expect(process?.sent).toContain('hurry up');
  });

  it('stops any run by id; a finished run answers 409 and an unknown one 404', async () => {
    const { http, app } = start({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app);
    const process = app.runner.forTask(taskId);
    const detail = TaskDetailDtoSchema.parse(
      (await http.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json(),
    );
    const runId = detail.runs[0]?.id ?? '';

    const stop = await http.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });
    const again = await http.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });
    const unknown = await http.inject({ method: 'POST', url: '/api/runs/nope/stop' });

    expect(stop.statusCode).toBe(204);
    expect(process?.stopped).toBe(true);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'run_not_running' });
    expect(unknown.statusCode).toBe(404);
  });

  it('answers 404 for unknown sessions and runs and 400 for a bad afterSeq', async () => {
    const { http } = start();

    const session = await http.inject({ method: 'GET', url: '/api/sessions/nope' });
    const events = await http.inject({ method: 'GET', url: '/api/runs/nope/events' });
    const bad = await http.inject({ method: 'GET', url: '/api/runs/nope/events?afterSeq=abc' });
    const send = await http.inject({
      method: 'POST',
      url: '/api/sessions/nope/messages',
      payload: { text: 'x' },
    });

    expect(session.statusCode).toBe(404);
    expect(events.statusCode).toBe(404);
    expect(bad.statusCode).toBe(400);
    expect(send.statusCode).toBe(404);
  });
});

describe('overview, config and connections', () => {
  it('serve the shared DTOs', async () => {
    const { http } = start();

    const overview = await http.inject({ method: 'GET', url: '/api/overview' });
    const config = await http.inject({ method: 'GET', url: '/api/config' });
    const connections = await http.inject({ method: 'GET', url: '/api/connections' });

    expect(OverviewDtoSchema.safeParse(overview.json()).success).toBe(true);
    expect(ConfigDtoSchema.safeParse(config.json()).success).toBe(true);
    expect(ConnectionsDtoSchema.safeParse(connections.json()).success).toBe(true);
  });
});

describe('errors', () => {
  it('answers an unknown route with the ApiError shape', async () => {
    const { http } = start();

    const res = await http.inject({ method: 'GET', url: '/api/nothing-here' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      code: 'not_found',
      message: 'No such route: GET /api/nothing-here',
    });
  });

  it('answers an unexpected failure with 500, redacted and without a stack', async () => {
    const app = buildTestApp();
    app.getOverview.execute = () => Promise.reject(new Error('db password hunter2 failed'));
    const http = buildServer(app, {
      stream: new SseHub(),
      redact: (text) => text.replace('hunter2', '[redacted]'),
    });
    servers.push(http);

    const res = await http.inject({ method: 'GET', url: '/api/overview' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'internal', message: 'db password [redacted] failed' });
  });
});

describe('GET /api/health', () => {
  it('answers 200 with the running runs counted and claude unknown before the first probe', async () => {
    const { http, app } = start({ realRuns: true });
    await createTaskInNewThread(app);

    const res = await http.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    const health = HealthSchema.parse(res.json());
    expect(health).toMatchObject({
      status: 'ok',
      database: 'ok',
      claude: 'unknown',
      activeRuns: (await app.uow.run((tx) => tx.runs.listRunning())).length,
      version: '0.0.0-test',
    });
    expect(health.activeRuns).toBe(1);
    expect(app.connections.checked).toEqual([]);
  });

  it('answers 503 with database failed when the ping rejects', async () => {
    const { http, app } = start();
    app.database.failing = true;

    const res = await http.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'failed', database: 'failed' });
  });

  it.each([
    ['ok', 'ok', 200],
    ['warning', 'degraded', 200],
    ['failed', 'degraded', 200],
  ] as const)('maps a cached claude %s to status %s', async (claude, status, code) => {
    const { http, app } = start();
    app.connections.cached.set('claude', { status: claude, summary: '', details: [] });

    const res = await http.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(code);
    expect(res.json()).toMatchObject({ status, claude });
    expect(app.connections.checked).toEqual([]);
  });
});

describe('usage', () => {
  it('GET /api/usage reports the last seven days by default, grouped by day', async () => {
    const { http, app } = start();

    const res = await http.inject({ method: 'GET', url: '/api/usage' });

    expect(res.statusCode).toBe(200);
    const report = UsageReportSchema.parse(res.json());
    expect(report.groupBy).toBe('day');
    expect(report.to).toBe(app.clock.now());
    expect(Date.parse(report.to) - Date.parse(report.from)).toBe(7 * 86_400_000);
    expect(report.total.runs).toBe(0);
  });

  it('POST /api/usage/reset returns the fresh usage', async () => {
    const { http } = start();

    const res = await http.inject({ method: 'POST', url: '/api/usage/reset' });

    expect(res.statusCode).toBe(200);
    expect(UsageDtoSchema.parse(res.json())).toMatchObject({ todayTokens: 0, paused: false });
  });

  it('GET /api/usage accepts every grouping and an explicit window', async () => {
    const { http } = start();
    for (const groupBy of ['day', 'session', 'task', 'model']) {
      const res = await http.inject({
        method: 'GET',
        url: `/api/usage?from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z&groupBy=${groupBy}`,
      });
      expect(res.statusCode).toBe(200);
      expect(UsageReportSchema.parse(res.json()).groupBy).toBe(groupBy);
    }
  });

  it.each([
    ['from after to', 'from=2026-01-08T00:00:00Z&to=2026-01-01T00:00:00Z'],
    ['a window over 366 days', 'from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z'],
    ['a malformed date', 'from=yesterday'],
    ['an unknown groupBy', 'groupBy=week'],
    ['an unknown parameter', 'limit=5'],
  ])('GET /api/usage rejects %s with 400', async (_name, query) => {
    const { http } = start();

    const res = await http.inject({ method: 'GET', url: `/api/usage?${query}` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: expect.stringMatching(/^(validation_failed|invalid_input)$/),
    });
  });
});
