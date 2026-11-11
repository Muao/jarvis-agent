import { describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidInputError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

const input = { title: 'Health endpoint', description: 'Add GET /health returning 200' };

describe('CreateTask', () => {
  it('creates the task in Intake with a worktree, a status card and a journal row, then asks for a worker', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    const created = await app.createTask.execute(app.identity.dispatcher(thread.id), input);

    expect(created).toEqual({ taskId: 'T-1', branch: 'jarvis/T-1' });
    expect(app.task('T-1')).toMatchObject({
      stage: 'Intake',
      threadId: thread.id,
      title: input.title,
      branch: 'jarvis/T-1',
    });
    expect(app.worktrees.created).toEqual([
      { branch: 'jarvis/T-1', path: '/jarvis/worktrees/T-1' },
    ]);
    expect(app.db.tables.journal).toEqual([
      expect.objectContaining({
        taskId: 'T-1',
        type: 'task_created',
        data: {
          title: input.title,
          description: input.description,
          branch: 'jarvis/T-1',
          kind: 'build',
        },
      }),
    ]);
    const status = app.messagesOf(thread.id).filter((m) => m.kind === 'status');
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ taskId: 'T-1', body: { stage: 'Intake' } });
    expect(app.owner.delivered.map((m) => m.kind)).toEqual(['status']);
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: 'T-1', reason: 'start' }]);
    expect(app.events.published).toContainEqual({ type: 'task', id: 'T-1' });
  });

  it("renames the thread to the task's title, so it is findable in the thread list", async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread('Ти працюєш?');

    await app.createTask.execute(app.identity.dispatcher(thread.id), input);

    expect(app.db.tables.threads.get(thread.id)).toMatchObject({ title: input.title });
  });

  it('numbers tasks T-1, T-2 across threads', async () => {
    const app = buildTestApp();
    const a = await app.seed.thread();
    const b = await app.seed.thread();

    const first = await app.createTask.execute(app.identity.dispatcher(a.id), input);
    const second = await app.createTask.execute(app.identity.dispatcher(b.id), input);

    expect([first.taskId, second.taskId]).toEqual(['T-1', 'T-2']);
  });

  it('refuses a second active task in the same thread', async () => {
    const app = buildTestApp();
    const { thread } = await app.seed.task();

    await expect(
      app.createTask.execute(app.identity.dispatcher(thread.id), input),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('allows a new task in a thread whose task was cancelled', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Implementing' });
    await app.cancelTask.execute({ taskId: task.id });

    const created = await app.createTask.execute(app.identity.dispatcher(thread.id), input);

    expect(created.taskId).not.toBe(task.id);
  });

  it('is closed to workers (ADR-0004: identity decides, not input)', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task();

    await expect(app.createTask.execute(app.identity.worker(task), input)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('creates the worktree against an allow-listed repo and sets Task.targetRepo (ADR-0012)', async () => {
    const app = buildTestApp();
    app.repos.allow('owner/name');
    const thread = await app.seed.thread();

    const created = await app.createTask.execute(app.identity.dispatcher(thread.id), {
      ...input,
      repo: 'owner/name',
    });

    expect(app.task(created.taskId).targetRepo).toEqual({ owner: 'owner', name: 'name' });
    expect(app.worktrees.targetRepos).toEqual([{ owner: 'owner', name: 'name' }]);
  });

  it('rejects a disallowed repo and creates no task or worktree', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await expect(
      app.createTask.execute(app.identity.dispatcher(thread.id), {
        ...input,
        repo: 'someone/else',
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    expect(app.db.tables.tasks.size).toBe(0);
    expect(app.worktrees.created).toEqual([]);
    expect(app.db.tables.journal).toEqual([]);
  });

  it('leaves no partial state and sends nothing when the worktree cannot be created', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    app.worktrees.failNext(new Error('git failed'));

    await expect(app.createTask.execute(app.identity.dispatcher(thread.id), input)).rejects.toThrow(
      'git failed',
    );

    expect(app.db.tables.tasks.size).toBe(0);
    expect(app.db.tables.journal).toEqual([]);
    expect(app.db.tables.messages.size).toBe(0);
    expect(app.owner.delivered).toEqual([]);
    expect(app.runs.calls).toEqual([]);
    expect(app.events.published).toEqual([]);
  });
});
describe('CreateTask: ui_check tasks (ADR-0018)', () => {
  const pr = { title: 'Check PR 41', description: 'Walk the UI of pull request 41' };

  it("stands the task on the pull request's head and records the PR (AC-41, AC-43)", async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    app.repos.allow('burnjohn/jarvis-sandbox');

    const created = await app.createTask.execute(app.identity.dispatcher(thread.id), {
      ...pr,
      kind: 'ui_check',
      pr: 'https://github.com/burnjohn/jarvis-sandbox/pull/41',
    });

    expect(created.branch).toBe('jarvis-check/T-1');
    expect(app.task('T-1')).toMatchObject({
      kind: 'ui_check',
      stage: 'Intake',
      pr: { number: 41, url: 'https://github.com/burnjohn/jarvis-sandbox/pull/41' },
      targetRepo: { owner: 'burnjohn', name: 'jarvis-sandbox' },
    });
    expect(app.worktrees.checkedOut).toEqual([{ taskId: 'T-1', prNumber: 41 }]);
  });

  it('takes the repo from the reference, so "owner/name#41" needs no `repo` (AC-41)', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    app.repos.allow('burnjohn/jarvis-sandbox');

    await app.createTask.execute(app.identity.dispatcher(thread.id), {
      ...pr,
      kind: 'ui_check',
      pr: 'burnjohn/jarvis-sandbox#41',
    });

    expect(app.task('T-1')).toMatchObject({
      pr: { number: 41, url: 'https://github.com/burnjohn/jarvis-sandbox/pull/41' },
    });
  });

  it('builds the URL for a bare number given with `repo` (AC-41)', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    app.repos.allow('burnjohn/jarvis-sandbox');

    await app.createTask.execute(app.identity.dispatcher(thread.id), {
      ...pr,
      kind: 'ui_check',
      pr: '41',
      repo: 'burnjohn/jarvis-sandbox',
    });

    expect(app.task('T-1')).toMatchObject({
      pr: { number: 41, url: 'https://github.com/burnjohn/jarvis-sandbox/pull/41' },
    });
  });

  it('refuses a repo outside the allow-list, and creates nothing (AC-40)', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await expect(
      app.createTask.execute(app.identity.dispatcher(thread.id), {
        ...pr,
        kind: 'ui_check',
        pr: 'https://github.com/someone/else/pull/41',
      }),
    ).rejects.toThrowError(InvalidInputError);
    expect(app.db.tables.tasks.size).toBe(0);
    expect(app.worktrees.checkedOut).toEqual([]);
  });

  it('refuses a bare number that names no repo, saying how to name one', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await expect(
      app.createTask.execute(app.identity.dispatcher(thread.id), {
        ...pr,
        kind: 'ui_check',
        pr: '41',
      }),
    ).rejects.toThrowError(/does not say which repo/);
    expect(app.db.tables.tasks.size).toBe(0);
  });

  it('refuses a ui_check task with no pull request at all', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await expect(
      app.createTask.execute(app.identity.dispatcher(thread.id), { ...pr, kind: 'ui_check' }),
    ).rejects.toThrowError(/needs `pr`/);
  });

  it('refuses `pr` on a build task: a build task earns its own PR', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await expect(
      app.createTask.execute(app.identity.dispatcher(thread.id), {
        ...input,
        pr: 'burnjohn/jarvis-sandbox#41',
      }),
    ).rejects.toThrowError(/needs kind "ui_check"/);
  });

  it('turns a head that cannot be fetched into an input error, not a crash', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    app.repos.allow('burnjohn/jarvis-sandbox');
    app.worktrees.failNext(new Error("couldn't find remote ref pull/41/head"));

    await expect(
      app.createTask.execute(app.identity.dispatcher(thread.id), {
        ...pr,
        kind: 'ui_check',
        pr: 'burnjohn/jarvis-sandbox#41',
      }),
    ).rejects.toThrowError(/cannot check out pull request 41: .*pull\/41\/head/);
    expect(app.db.tables.tasks.size).toBe(0);
  });

  it('keeps a plain task a build task, with no PR (AC-36)', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await app.createTask.execute(app.identity.dispatcher(thread.id), input);

    expect(app.task('T-1')).toMatchObject({ kind: 'build', pr: null, branch: 'jarvis/T-1' });
  });

  it('pins the configured worker model on the task, and the model the owner named over it', async () => {
    const app = buildTestApp();
    app.config.set({
      ...app.config.current(),
      models: { ...app.config.current().models, worker: 'opus' },
    });
    const first = await app.seed.thread();
    const second = await app.seed.thread();

    const byDefault = await app.createTask.execute(app.identity.dispatcher(first.id), input);
    const named = await app.createTask.execute(app.identity.dispatcher(second.id), {
      ...input,
      model: 'haiku',
    });

    expect(app.task(byDefault.taskId).model).toBe('opus');
    expect(app.task(named.taskId).model).toBe('haiku');
  });

  it('leaves the model unpinned when the configured one is not an alias', async () => {
    const app = buildTestApp();
    app.config.set({
      ...app.config.current(),
      models: { ...app.config.current().models, worker: 'claude-sonnet-5-5' },
    });
    const thread = await app.seed.thread();

    const created = await app.createTask.execute(app.identity.dispatcher(thread.id), input);

    expect(app.task(created.taskId).model).toBeNull();
  });
});
