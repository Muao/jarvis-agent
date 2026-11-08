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
        data: { title: input.title, description: input.description, branch: 'jarvis/T-1' },
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

  it('is closed to workers (ADR-0005: identity decides, not input)', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task();

    await expect(app.createTask.execute(app.identity.worker(task), input)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('creates the worktree against an allow-listed repo and sets Task.targetRepo (ADR-0019)', async () => {
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
