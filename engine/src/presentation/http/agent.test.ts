import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createTaskInNewThread,
  type TestApp,
} from '../../application/testing/index.js';
import { SseHub } from '../../infrastructure/sse/sse-hub.js';
import { buildServer } from './server.js';

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A worker run with a live process: its run token is what the MCP server would send. */
async function workerRun() {
  const app = buildTestApp({ realRuns: true });
  const http = buildServer(app, { stream: new SseHub() });
  servers.push(http);
  const { taskId, thread } = await createTaskInNewThread(app);
  const process = app.runner.forTask(taskId);
  if (process === undefined) throw new Error('the worker did not start');
  return { app, http, taskId, thread, process, token: process.spec.runToken };
}

async function dispatcherRun() {
  const app = buildTestApp({ realRuns: true });
  const http = buildServer(app, { stream: new SseHub() });
  servers.push(http);
  const { threadId } = await app.postOwnerMessage.execute({ text: 'Add a page' });
  return { app, http, thread: { id: threadId } };
}

const call = (http: FastifyInstance, tool: string, token: string | null, payload: unknown = {}) =>
  http.inject({
    method: 'POST',
    url: `/api/agent/tools/${tool}`,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload: payload as object,
  });

describe('agent tools: authentication', () => {
  it('answers 401 without a token and 403 with an unknown one', async () => {
    const { http } = await workerRun();

    const none = await call(http, 'log_note', null, { text: 'x' });
    const malformed = await http.inject({
      method: 'POST',
      url: '/api/agent/tools/log_note',
      headers: { authorization: 'Basic abc' },
      payload: { text: 'x' },
    });
    const unknown = await call(http, 'log_note', 'not-a-token', { text: 'x' });

    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ code: 'unauthorized' });
    expect(malformed.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json()).toMatchObject({ code: 'forbidden' });
  });

  it('answers 403 once the run has finished', async () => {
    const { http, token, process } = await workerRun();
    await process.succeed();

    const res = await call(http, 'log_note', token, { text: 'late' });

    expect(res.statusCode).toBe(403);
  });

  it('keeps the permission route behind the same token check', async () => {
    const { http } = await workerRun();

    const none = await http.inject({
      method: 'POST',
      url: '/api/agent/permissions',
      payload: { tool_name: 'Bash', input: {} },
    });
    const unknown = await http.inject({
      method: 'POST',
      url: '/api/agent/permissions',
      headers: { authorization: 'Bearer nope' },
      payload: { tool_name: 'Bash', input: {} },
    });

    expect(none.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(403);
  });
});

describe('agent tools: role and input', () => {
  it('refuses a tool outside the caller role with 403', async () => {
    const { http, token } = await workerRun();

    const res = await call(http, 'create_task', token, { title: 't', description: 'd' });

    expect(res.statusCode).toBe(403);
  });

  it('refuses a worker tool for a dispatcher run with 403', async () => {
    const { http, app } = await dispatcherRun();
    const token = app.runner.processes[0]?.spec.runToken ?? '';

    const res = await call(http, 'report_stage', token, { stage: 'Verifying' });

    expect(res.statusCode).toBe(403);
  });

  it('answers 404 for an unknown tool and for approve (it has its own route)', async () => {
    const { http, token } = await workerRun();

    const unknown = await call(http, 'rm_rf', token);
    const approve = await call(http, 'approve', token, { tool_name: 'Bash', input: {} });

    expect(unknown.statusCode).toBe(404);
    expect(approve.statusCode).toBe(404);
  });

  it('answers 400 for input that carries an identity or breaks the schema (ADR-0004)', async () => {
    const { http, token } = await workerRun();

    const identity = await call(http, 'log_note', token, { text: 'x', taskId: 'T-9' });
    const empty = await call(http, 'log_note', token, { text: '' });
    const stage = await call(http, 'report_stage', token, { stage: 'Done' });

    expect([identity.statusCode, empty.statusCode, stage.statusCode]).toEqual([400, 400, 400]);
    expect(identity.json()).toMatchObject({ code: 'validation_failed' });
  });
});

describe('agent tools: dispatcher', () => {
  it('create_task answers with the task id and branch, reply with the message id', async () => {
    const { http, app, thread } = await dispatcherRun();
    const token = app.runner.processes[0]?.spec.runToken ?? '';

    const created = await call(http, 'create_task', token, {
      title: 'Page',
      description: 'Add a page',
    });
    const replied = await call(http, 'reply', token, { text: 'On it.' });
    const listed = await call(http, 'list_tasks', token);

    expect(created.json()).toEqual({ taskId: 'T-1', branch: 'jarvis/T-1' });
    expect(replied.json()).toEqual({ messageId: expect.any(String) });
    expect(listed.json().text).toContain('T-1');
    expect(app.messagesOf(thread.id).some((m) => m.kind === 'jarvis')).toBe(true);
  });

  it('cancel_task and send_to_task take the target task, not an identity', async () => {
    const { http, app, thread } = await dispatcherRun();
    const token = app.runner.processes[0]?.spec.runToken ?? '';
    await call(http, 'create_task', token, { title: 'Page', description: 'Add a page' });

    const sent = await call(http, 'send_to_task', token, {
      task: 'T-1',
      message: 'also dark mode',
    });
    const cancelled = await call(http, 'cancel_task', token, {
      task: 'T-1',
      reason: 'changed my mind',
    });
    const missing = await call(http, 'cancel_task', token, { task: 'T-99' });

    expect(sent.json()).toEqual({ ok: true });
    expect(cancelled.json()).toEqual({ ok: true });
    expect(app.task('T-1').stage).toBe('Cancelled');
    expect(missing.statusCode).toBe(404);
    expect(thread.id).toBeTruthy();
  });

  it('create_task accepts an allow-listed repo and creates the worktree against it', async () => {
    const { http, app } = await dispatcherRun();
    const token = app.runner.processes[0]?.spec.runToken ?? '';
    app.repos.allow('owner/name');

    const created = await call(http, 'create_task', token, {
      title: 'Page',
      description: 'Add a page',
      repo: 'owner/name',
    });

    expect(created.json()).toMatchObject({ taskId: 'T-1' });
    expect(app.task('T-1').targetRepo).toEqual({ owner: 'owner', name: 'name' });
    // start-run.ts also calls worktrees.create (idempotent) once the worker run is scheduled.
    for (const targetRepo of app.worktrees.targetRepos) {
      expect(targetRepo).toEqual({ owner: 'owner', name: 'name' });
    }
  });

  it('create_task rejects a repo outside the allow-list (400) and creates nothing', async () => {
    const { http, app } = await dispatcherRun();
    const token = app.runner.processes[0]?.spec.runToken ?? '';

    const rejected = await call(http, 'create_task', token, {
      title: 'Page',
      description: 'Add a page',
      repo: 'someone/else',
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().message).toContain('someone/else');
    expect(app.db.tables.tasks.size).toBe(0);
  });

  it('set_task_target_repo rejects redirecting a task whose worktree already exists (400)', async () => {
    const { http, app } = await dispatcherRun();
    const token = app.runner.processes[0]?.spec.runToken ?? '';
    await call(http, 'create_task', token, { title: 'Page', description: 'Add a page' });
    app.repos.allow('owner/name');

    const rejected = await call(http, 'set_task_target_repo', token, {
      task: 'T-1',
      repo: 'owner/name',
    });

    expect(rejected.statusCode).toBe(400);
    expect(app.task('T-1').targetRepo).toBeNull();
  });

  it('remember appends a fact through the profile store (ADR-0013)', async () => {
    const { http, app } = await dispatcherRun();
    const token = app.runner.processes[0]?.spec.runToken ?? '';

    const res = await call(http, 'remember', token, {
      fact: 'the QuickBlog repo is burnjohn/quick-blog',
    });

    expect(res.json()).toEqual({ ok: true });
    expect(app.profile.learned).toEqual(['the QuickBlog repo is burnjohn/quick-blog']);
  });
});

describe('agent tools: worker', () => {
  it('log_note lands in the task journal', async () => {
    const { http, app, token, taskId } = await workerRun();

    const res = await call(http, 'log_note', token, { text: 'found the config' });

    expect(res.json()).toEqual({ ok: true });
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      taskId,
      type: 'agent_note',
      actor: 'agent',
      data: { text: 'found the config' },
    });
  });

  it('runs the spec, stage, checks and PR tools for the run task', async () => {
    const { http, app, token, taskId } = await workerRun();
    app.artifacts.write(taskId, 'spec.md', '# spec');
    app.artifacts.write(taskId, 'plan.md', '# plan');

    const submitted = await call(http, 'submit_spec_for_approval', token, { summary: 'Add page' });
    await app.answerDecision.execute(submitted.json().cardId, { decision: 'approve' });
    const staged = await call(http, 'report_stage', token, { stage: 'Verifying' });
    const checked = await call(http, 'report_checks', token, { passed: true, summary: 'green' });
    const pr = await call(http, 'report_pr', token, {
      number: 7,
      url: 'https://github.com/o/r/pull/7',
    });

    expect(submitted.statusCode).toBe(200);
    expect(staged.json()).toEqual({ ok: true });
    expect(checked.json()).toEqual({ outcome: 'passed' });
    expect(pr.json()).toEqual({ ok: true });
    expect(app.task(taskId)).toMatchObject({ stage: 'PR Open' });
  });

  it('maps a domain refusal to 409 and a missing artifact to 404', async () => {
    const { http, token } = await workerRun();

    const noSpec = await call(http, 'submit_spec_for_approval', token, { summary: 's' });
    const illegal = await call(http, 'report_pr', token, {
      number: 1,
      url: 'https://x.dev/pull/1',
    });

    expect(noSpec.statusCode).toBe(404);
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json()).toMatchObject({ code: 'illegal_transition' });
  });

  it('ask_owner blocks the task and returns the card id', async () => {
    const { http, app, token, taskId } = await workerRun();

    const res = await call(http, 'ask_owner', token, { question: 'Which?', options: ['a', 'b'] });

    expect(res.json()).toEqual({ cardId: expect.any(String) });
    expect(app.task(taskId).stage).toBe('Blocked');
  });
});

describe('POST /api/agent/permissions', () => {
  async function pendingPermissionId(app: TestApp, threadId: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const card = app.messagesOf(threadId).find((m) => m.kind === 'permission');
      if (card !== undefined) return String(card.body.permissionId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('no permission card appeared');
  }

  it('holds the request until the owner answers, then returns the approve result', async () => {
    const { http, app, token, thread } = await workerRun();
    const input = { command: 'rm -rf build' };

    const waiting = http.inject({
      method: 'POST',
      url: '/api/agent/permissions',
      headers: { authorization: `Bearer ${token}` },
      payload: { tool_name: 'Bash', input, tool_use_id: 'tu-1' },
    });
    const permissionId = await pendingPermissionId(app, thread.id);
    const answer = await http.inject({
      method: 'POST',
      url: `/api/permissions/${permissionId}`,
      payload: { decision: 'allow' },
    });
    const res = await waiting;

    expect(answer.statusCode).toBe(204);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('returns a deny with a message when the owner denies', async () => {
    const { http, app, token, thread } = await workerRun();

    const waiting = http.inject({
      method: 'POST',
      url: '/api/agent/permissions',
      headers: { authorization: `Bearer ${token}` },
      payload: { tool_name: 'Bash', input: {} },
    });
    const permissionId = await pendingPermissionId(app, thread.id);
    await http.inject({
      method: 'POST',
      url: `/api/permissions/${permissionId}`,
      payload: { decision: 'deny' },
    });

    expect((await waiting).json()).toMatchObject({ behavior: 'deny' });
  });

  it('answers 400 for a body without tool_name', async () => {
    const { http, token } = await workerRun();

    const res = await http.inject({
      method: 'POST',
      url: '/api/agent/permissions',
      headers: { authorization: `Bearer ${token}` },
      payload: { input: {} },
    });

    expect(res.statusCode).toBe(400);
  });
});
