// The whole engine on real parts (ADR-0011): Postgres `jarvis_test`, the real ClaudeCliRunner pointed at
// the fake `claude`, real Fastify on an ephemeral port, a temp git repo and a temp Jarvis Home.
// Nothing here runs the real `claude`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { FakeCodeHost } from '../../src/application/testing/fake-code-host.js';
import { createContainer, type Container } from '../../src/container.js';
import { createPool, migrate } from '../../src/infrastructure/db/index.js';
import { resetDatabase, testDatabaseUrl } from '../db.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

const GITHUB_URL = 'git@github.com:example/repo.git';
const PR_URL = 'https://github.com/example/repo/pull/7';
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';
// Red until a worker commits `fixed.txt`.
const FIXED_FILE = "node -e \"process.exit(require('fs').existsSync('fixed.txt')?0:1)\"";

interface Flow {
  readonly root: string;
  readonly bare: string;
  readonly home: string;
  readonly container: Container;
  readonly host: FakeCodeHost;
  readonly url: string;
  readonly streamed: StreamEvent[];
  close(): Promise<void>;
}

/**
 * One engine on real parts: a repo whose `origin` is a local bare repository (it looks like a GitHub URL, so the
 * engine knows owner and name; `insteadOf` and `publisherRemoteUrl` send fetch and push to the bare one), a fake
 * code host that records pull requests, and a fake `claude` playing `scenario`.
 */
async function startFlow(options: {
  scenario: string;
  checkCommand: string;
  checkRetries?: number;
}): Promise<Flow> {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-flow-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const bare = join(root, 'ssh', 'example', 'repo.git');
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'flow@example.com');
  git(repo, 'config', 'user.name', 'Flow');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'AGENTS.md'), `# Repo\n\n- Test: \`${options.checkCommand}\`\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  mkdirSync(dirname(bare), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', repo, bare]);
  git(repo, 'remote', 'add', 'origin', GITHUB_URL);
  // `git@github.com:example/repo.git` is read by the engine as a GitHub repository, so its owner and name are
  // known; the "ssh" that git runs for it is a script that serves the bare repository instead of connecting.
  const fakeSsh = join(root, 'fake-ssh.sh');
  writeFileSync(fakeSsh, `#!/bin/sh\ncd "${join(root, 'ssh')}" && exec sh -c "$2"\n`, {
    mode: 0o755,
  });
  git(repo, 'config', 'core.sshCommand', fakeSsh);
  git(repo, 'fetch', '-q', 'origin');

  execFileSync('mkdir', ['-p', home]);
  writeFileSync(
    join(home, 'jarvis.config.json'),
    JSON.stringify({
      repo: { path: repo, remote: 'origin', baseBranch: 'main' },
      engine: { claudeBinary: FAKE_CLAUDE },
      // The fake worker brings up no real project: keep these flows off Docker.
      ui: { enabled: false },
      ...(options.checkRetries === undefined
        ? {}
        : { limits: { checkRetries: options.checkRetries } }),
    }),
  );

  const pool = createPool(testDatabaseUrl());
  await migrate(pool);
  await resetDatabase(pool);
  await pool.end();

  const host = new FakeCodeHost();
  host.createPullRequestResult = { ok: true, number: 7, url: PR_URL, created: true };
  const container = await createContainer({
    env: {
      DATABASE_URL: testDatabaseUrl(),
      JARVIS_HOME: home,
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      JARVIS_LOG_LEVEL: 'warn',
    },
    port: 0,
    runnerEnv: { JARVIS_FAKE_SCENARIO: options.scenario },
    codeHost: host,
    publisherRemoteUrl: () => `file://${bare}`,
  });
  const url = await container.listen();
  const streamed: StreamEvent[] = [];
  const stopStream = new AbortController();
  await collectStream(url, streamed, stopStream.signal);

  return {
    root,
    bare,
    home,
    container,
    host,
    url,
    streamed,
    close: async () => {
      stopStream.abort();
      await container.close();
      const cleanup = createPool(testDatabaseUrl());
      await resetDatabase(cleanup);
      await cleanup.end();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitFor<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The HTTP side of one flow. */
function client(flow: Flow) {
  const api = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${flow.url}${path}`, init);
  const json = async <T>(path: string, parse: (value: unknown) => T): Promise<T> =>
    parse(await (await api(path)).json());
  return {
    api,
    json,
    post: (path: string, body?: unknown) =>
      api(path, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }),
    thread: (id: string) => json(`/api/threads/${id}`, (v) => ThreadDetailDtoSchema.parse(v)),
    task: (id: string) => json(`/api/tasks/${id}`, (v) => TaskDetailDtoSchema.parse(v)),
  };
}

/** Collects `GET /api/stream` frames until `signal` aborts. */
async function collectStream(
  url: string,
  streamed: StreamEvent[],
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${url}/api/stream`, { signal });
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

/** Message -> task T-1 -> spec card. Returns what the next step needs. */
async function runToSpecCard(flow: Flow) {
  const c = client(flow);
  const res = await c.post('/api/threads', { text: 'Add a page' });
  expect(res.status).toBe(201);
  const threadId = ThreadDetailDtoSchema.parse(await res.json()).id;
  const detail = await waitFor('a decision card in Spec Review', async () => {
    const current = await c.thread(threadId);
    return current.stage === 'Spec Review' && current.messages.some((m) => m.kind === 'decision')
      ? current
      : undefined;
  });
  return {
    c,
    threadId,
    taskId: detail.taskId ?? '',
    cardId: detail.messages.find((m) => m.kind === 'decision')?.id ?? '',
  };
}

const git2 = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Journal types of a task, in order, from the API. */
const journalTypes = (detail: TaskDetailDto): string[] => detail.journal.map((e) => e.type);

/** True when `wanted` appears in `all` in that order (other events may sit between). */
function inOrder(all: readonly string[], wanted: readonly string[]): boolean {
  let at = 0;
  for (const type of all) if (type === wanted[at]) at += 1;
  return at === wanted.length;
}

describe('message to draft PR, with the fake claude', () => {
  let flow: Flow;
  let c: ReturnType<typeof client>;
  let api: ReturnType<typeof client>['api'];
  let json: ReturnType<typeof client>['json'];
  let post: ReturnType<typeof client>['post'];
  let thread: ReturnType<typeof client>['thread'];
  let task: ReturnType<typeof client>['task'];
  let streamed: StreamEvent[];
  let worktreeHead = '';

  beforeAll(async () => {
    flow = await startFlow({ scenario: 'flow', checkCommand: PASS });
    c = client(flow);
    ({ api, json, post, thread, task } = c);
    void api;
    streamed = flow.streamed;
  }, 30_000);

  afterAll(async () => {
    await flow?.close();
  });

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

  it('approval resumes the worker, whose open_pr runs the checks, pushes and opens the PR: PR Open and a result card', async () => {
    const res = await post(`/api/messages/${decisionCardId}/answer`, { decision: 'approve' });
    expect(res.status).toBe(204);

    const finished = await waitFor('PR Open', async () => {
      const current = await task(taskId);
      return current.stage === 'PR Open' ? current : undefined;
    });

    expect(finished).toMatchObject({
      prNumber: 7,
      prUrl: PR_URL,
      counters: { checks: { used: 0 } },
    });

    // The engine pushed exactly the commit it checked, to the bare repository, and opened one draft PR.
    const worktree = join(flow.home, 'worktrees', taskId);
    worktreeHead = git2(worktree, 'rev-parse', 'HEAD');
    expect(git2(flow.bare, 'rev-parse', 'refs/heads/jarvis/T-1')).toBe(worktreeHead);
    expect(flow.host.pullRequests).toHaveLength(1);
    expect(flow.host.pullRequests[0]?.input).toMatchObject({
      head: 'jarvis/T-1',
      base: 'main',
      title: 'Add an About page',
    });
    expect(flow.host.pullRequests[0]?.input.body).toContain('## Checks (run by Jarvis)');

    const types = journalTypes(await task(taskId));
    expect(
      inOrder(types, [
        'checks_fixed',
        'checks_started',
        'checks_passed',
        'branch_pushed',
        'pr_opened',
      ]),
    ).toBe(true);
    expect(types).not.toContain('checks_failed');
    const chat = await thread(threadId);
    const result = chat.messages.find((m) => m.kind === 'result');
    expect(result).toMatchObject({
      body: { taskId, prUrl: PR_URL },
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

    for (const run of detail.runs) {
      expect(run.stopReason).toBe('success');
      expect(run.modelUsage).toEqual({
        'fake-model': { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costUsd: 0.01 },
      });
    }

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
      'Reviewing',
      'Verifying',
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

  it('a fix round after red CI gets the failed log as a file and a notice naming it', async () => {
    const taskId = 'T-1';
    const sha7 = worktreeHead.slice(0, 7);
    flow.host.failedLogs = [
      { name: 'test', conclusion: 'failure', url: null, logTail: 'AssertionError: boom' },
    ];
    flow.host.set(7, {
      headSha: worktreeHead,
      checks: [
        {
          id: 1,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          url: 'https://ci.example/1',
        },
      ],
      reviews: [],
      comments: [],
    });
    await flow.container.app.pollPullRequests.execute();

    const logFile = join(flow.home, 'tasks', taskId, 'fix', `ci-${sha7}.log`);
    const message = join(flow.home, 'tasks', taskId, 'first-message.txt');
    await waitFor('the fix round worker to start', async () =>
      existsSync(message) ? true : undefined,
    );
    expect(readFileSync(logFile, 'utf8').startsWith('<untrusted-content')).toBe(true);
    expect(readFileSync(logFile, 'utf8')).toContain('AssertionError: boom');
    expect(readFileSync(message, 'utf8')).toContain(`fix/ci-${sha7}.log`);
    expect(flow.host.failedLogCalls).toEqual([{ prNumber: 7, headSha: worktreeHead, repo: null }]);
  });
});

describe('the check gate (ADR-0022)', () => {
  it('red, then fixed: PR Open only after the second open_pr; the streak is reset', async () => {
    const flow = await startFlow({ scenario: 'flow-red', checkCommand: FIXED_FILE });
    try {
      const { c, taskId, cardId } = await runToSpecCard(flow);
      expect((await c.post(`/api/messages/${cardId}/answer`, { decision: 'approve' })).status).toBe(
        204,
      );

      const finished = await waitFor('PR Open', async () => {
        const current = await c.task(taskId);
        return current.stage === 'PR Open' ? current : undefined;
      });

      expect(finished).toMatchObject({ prNumber: 7, counters: { checks: { used: 0 } } });
      const types = journalTypes(finished);
      expect(types.filter((t) => t === 'checks_failed')).toHaveLength(1);
      expect(
        inOrder(types, [
          'checks_fixed',
          'checks_started',
          'checks_failed',
          'checks_started',
          'checks_passed',
          'branch_pushed',
          'pr_opened',
        ]),
      ).toBe(true);
      expect(flow.host.pullRequests).toHaveLength(1);
      const head = git2(join(flow.home, 'worktrees', taskId), 'rev-parse', 'HEAD');
      expect(git2(flow.bare, 'rev-parse', 'refs/heads/jarvis/T-1')).toBe(head);
      // The pushed commit holds the fix.
      expect(git2(flow.bare, 'show', `${head}:fixed.txt`)).toBe('fixed');
    } finally {
      await flow.close();
    }
  }, 60_000);

  it('red until the retries are used up: Failed with checks_exhausted, nothing pushed, no PR', async () => {
    const flow = await startFlow({
      scenario: 'flow-exhausted',
      checkCommand: FAIL,
      checkRetries: 1,
    });
    try {
      const { c, taskId, cardId } = await runToSpecCard(flow);
      expect((await c.post(`/api/messages/${cardId}/answer`, { decision: 'approve' })).status).toBe(
        204,
      );

      const failed = await waitFor('Failed', async () => {
        const current = await c.task(taskId);
        return current.stage === 'Failed' ? current : undefined;
      });

      expect(failed.reason).toContain('Checks still failing after 1 retries');
      expect(failed.counters.checks.used).toBe(1);
      expect(failed.prNumber).toBeNull();
      const types = journalTypes(failed);
      expect(types.filter((t) => t === 'checks_failed')).toHaveLength(2);
      expect(types).not.toContain('checks_passed');
      expect(types).not.toContain('branch_pushed');
      expect(flow.host.pullRequests).toHaveLength(0);
      expect(git2(flow.bare, 'for-each-ref', 'refs/heads/jarvis/')).toBe('');
    } finally {
      await flow.close();
    }
  }, 60_000);
});
