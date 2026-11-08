import { describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('SetTaskTargetRepo', () => {
  it('rejects redirecting a task whose worktree already exists for a different repo, and changes nothing', async () => {
    // ADR-0012 follow-up: a task's worktree is fixed at create_task time, so a later call naming a
    // *different* repo could never actually take effect; it must reject clearly instead of
    // silently no-op'ing against the already-created worktree.
    const app = buildTestApp();
    app.repos.allow('owner/name');
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await expect(
      app.setTaskTargetRepo.execute(app.identity.dispatcher(task.threadId), {
        taskId: task.id,
        repo: 'owner/name',
      }),
    ).rejects.toThrow(InvalidInputError);

    expect(app.task(task.id).targetRepo).toBeNull();
  });

  it("is a harmless no-op when the repo already matches the task's target repo", async () => {
    const app = buildTestApp();
    app.repos.allow('owner/name');
    const { task } = await app.seed.task({
      stage: 'Implementing',
      targetRepo: { owner: 'owner', name: 'name' },
    });

    await app.setTaskTargetRepo.execute(app.identity.dispatcher(task.threadId), {
      taskId: task.id,
      repo: 'owner/name',
    });

    expect(app.task(task.id).targetRepo).toEqual({ owner: 'owner', name: 'name' });
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      type: 'target_repo_set',
      data: { owner: 'owner', name: 'name' },
    });
  });

  it('rejects a repo outside the allow-list with a clear reason, and changes nothing', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await expect(
      app.setTaskTargetRepo.execute(app.identity.dispatcher(task.threadId), {
        taskId: task.id,
        repo: 'someone/else',
      }),
    ).rejects.toThrow(InvalidInputError);

    expect(app.task(task.id).targetRepo).toBeNull();
  });

  it('is dispatcher-only', async () => {
    const app = buildTestApp();
    app.repos.allow('owner/name');
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await expect(
      app.setTaskTargetRepo.execute(app.identity.worker(task), {
        taskId: task.id,
        repo: 'owner/name',
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('rejects an unknown task', async () => {
    const app = buildTestApp();
    app.repos.allow('owner/name');
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await expect(
      app.setTaskTargetRepo.execute(app.identity.dispatcher(task.threadId), {
        taskId: 'T-999',
        repo: 'owner/name',
      }),
    ).rejects.toThrow(NotFoundError);
  });
});
