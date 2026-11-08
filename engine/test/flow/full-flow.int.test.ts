// The whole engine on real parts (ADR-0013): Postgres `jarvis_test`, the real ClaudeCliRunner pointed at
// the fake `claude`, real Fastify on an ephemeral port, a temp git repo and a temp Jarvis Home.
// Nothing here runs the real `claude`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RunEventsDtoSchema,
  StreamEventSchema,
  TaskDetailDtoSchema,
  ThreadDetailDtoSchema,
  type StreamEvent,
  type TaskDetailDto,
} from '@jarvis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer, type Container } from '../../src/container.js';
import { createPool, migrate } from '../../src/infrastructure/db/index.js';
import { resetDatabase, testDatabaseUrl } from '../db.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

let root: string;
let container: Container;
let url: string;
const streamed: StreamEvent[] = [];
const stopStream = new AbortController();

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${url}${path}`, init);
}

async function json<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  return parse(await (await api(path)).json());
}

const post = (path: string, body?: unknown) =>
  api(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

async function waitFor<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const thread = (id: string) => json(`/api/threads/${id}`, (v) => ThreadDetailDtoSchema.parse(v));
const task = (id: string) => json(`/api/tasks/${id}`, (v) => TaskDetailDtoSchema.parse(v));

/** Collects `GET /api/stream` frames until the test ends. */
async function collectStream(): Promise<void> {
  const response = await api('/api/stream', { signal: stopStream.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('no stream body');
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.startsWith('data: ')) {
            streamed.push(StreamEventSchema.parse(JSON.parse(frame.slice(6))));
          }
        }
      }
    } catch {
      // aborted at the end of the test
    }
  })();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-flow-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'flow@example.com');
  git(repo, 'config', 'user.name', 'Flow');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'AGENTS.md'), '# Repo\n\n- Test: `pnpm test`\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');

  execFileSync('mkdir', ['-p', home]);
  writeFileSync(
    join(home, 'jarvis.config.json'),
    JSON.stringify({
      repo: { path: repo, remote: 'origin', baseBranch: 'main' },
      engine: { claudeBinary: FAKE_CLAUDE },
    }),
  );

  const pool = createPool(testDatabaseUrl());
  await migrate(pool);
  await resetDatabase(pool);
  await pool.end();

  container = await createContainer({
    env: {
      DATABASE_URL: testDatabaseUrl(),
      JARVIS_HOME: home,
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      JARVIS_LOG_LEVEL: 'warn',
    },
    port: 0,
    runnerEnv: { JARVIS_FAKE_SCENARIO: 'flow' },
  });
  url = await container.listen();
  await collectStream();
}, 30_000);

afterAll(async () => {
  stopStream.abort();
  await container?.close();
  const pool = createPool(testDatabaseUrl());
  await resetDatabase(pool);
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

describe('message to draft PR, with the fake claude', () => {
  let threadId: string;
  let taskId: string;
  let decisionCardId: string;

  it('turns the first message into a task: the dispatcher creates it and replies', async () => {
    const res = await post('/api/threads', { text: 'Add a page' });
    expect(res.status).toBe(201);
    threadId = ThreadDetailDtoSchema.parse(await res.json()).id;

    const created = await waitFor('task T-1 and the dispatcher reply', async () => {
      const detail = await thread(threadId);
      const replied = detail.messages.some(
        (m) => m.kind === 'jarvis' && m.body.text.includes('T-1'),
      );
      return replied && detail.taskId !== null ? detail : undefined;
    });

    taskId = created.taskId ?? '';
    expect(taskId).toBe('T-1');
    expect(created.messages.map((m) => m.kind)).toEqual(
      expect.arrayContaining(['owner', 'status', 'jarvis']),
    );
  });

  it('the worker writes the artifacts and asks for approval with a decision card', async () => {
    const detail = await waitFor('a decision card in Spec Review', async () => {
      const current = await thread(threadId);
      return current.stage === 'Spec Review' && current.messages.some((m) => m.kind === 'decision')
        ? current
        : undefined;
    });

    const card = detail.messages.find((m) => m.kind === 'decision');
    expect(card).toMatchObject({
      answer: null,
      body: { taskId, artifacts: ['spec.md', 'plan.md'] },
    });
    decisionCardId = card?.id ?? '';

    const states = (await task(taskId)).artifacts;
    expect(states.filter((a) => a.exists).map((a) => a.name)).toEqual([
      'context.md',
      'spec.md',
      'plan.md',
      'tasks.md',
    ]);
    const spec = await json(
      `/api/tasks/${taskId}/artifacts/spec.md`,
      (v) => v as { content: string },
    );
    expect(spec.content).toContain('About page');
  });

  it('approval resumes the worker, which reports checks and the PR: PR Open and a result card', async () => {
    const res = await post(`/api/messages/${decisionCardId}/answer`, { decision: 'approve' });
    expect(res.status).toBe(204);

    const finished = await waitFor('PR Open', async () => {
      const current = await task(taskId);
      return current.stage === 'PR Open' ? current : undefined;
    });

    expect(finished).toMatchObject({
      prNumber: 7,
      prUrl: 'https://github.com/example/repo/pull/7',
      counters: { checks: { used: 0 } },
    });
    const chat = await thread(threadId);
    const result = chat.messages.find((m) => m.kind === 'result');
    expect(result).toMatchObject({
      body: { taskId, prUrl: 'https://github.com/example/repo/pull/7' },
    });
    expect(chat.messages.find((m) => m.kind === 'decision')?.answer).toEqual({
      decision: 'approve',
    });
  });

  it('stores the runs and their events, readable over the API', async () => {
    const detail: TaskDetailDto = await waitFor('both worker runs finished', async () => {
      const current = await task(taskId);
      return current.runs.length === 2 && current.runs.every((r) => r.status === 'completed')
        ? current
        : undefined;
    });
    const firstRun = detail.runs.at(0);
    const resumed = detail.runs.at(-1);

    const events = await json(`/api/runs/${firstRun?.id}/events`, (v) =>
      RunEventsDtoSchema.parse(v),
    );
    const tools = events.events
      .filter((e) => e.kind === 'tool_use')
      .map((e) => String((e.payload as { name?: unknown }).name));
    expect(tools).toEqual(['Read', 'mcp__jarvis__submit_spec_for_approval']);
    expect(events.events.map((e) => e.seq)).toEqual(events.events.map((_, i) => i));

    const after = await json(`/api/runs/${firstRun?.id}/events?afterSeq=1`, (v) =>
      RunEventsDtoSchema.parse(v),
    );
    expect(after.events[0]?.seq).toBe(2);

    const session = await json(
      `/api/sessions/${detail.workerSessionId}`,
      (v) => v as { runs: unknown[] },
    );
    expect(session.runs).toHaveLength(2);
    expect(resumed?.costUsd).toBeGreaterThan(0);
  });

  it('shows the journal and the stage history of the whole flow', async () => {
    const detail = await task(taskId);

    expect(detail.stages.map((s) => s.stage)).toEqual([
      'Intake',
      'Context',
      'Spec Review',
      'Implementing',
      'Verifying',
      'Reviewing',
      'PR Open',
    ]);
    expect(detail.journal.length).toBeGreaterThan(5);
  });

  it('pushed thread, task, run, run_event and overview notifications over the stream', async () => {
    await waitFor('stream notifications', async () => {
      const types = new Set(streamed.map((e) => e.type));
      return ['thread', 'task', 'run', 'run_event', 'overview'].every((t) => types.has(t as never))
        ? true
        : undefined;
    });

    expect(streamed).toContainEqual({ type: 'task', id: taskId });
    expect(streamed).toContainEqual({ type: 'thread', id: threadId });
  });
});
