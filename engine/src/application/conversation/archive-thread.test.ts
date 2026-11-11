import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors.js';
import { buildTestApp } from '../testing/index.js';

describe('ArchiveThread', () => {
  it('archives a thread with a task under way and brings it back, leaving its activity time alone', async () => {
    const app = buildTestApp();
    const { thread, task } = await app.seed.task({ stage: 'Implementing' });

    await app.archiveThread.execute({ threadId: thread.id, archived: true });

    const archived = await app.getThread.execute(thread.id);
    expect(archived).toMatchObject({ archived: true, lastActivityAt: thread.updatedAt });
    expect((await app.getThreads.execute()).map((row) => row.archived)).toEqual([true]);
    expect(app.task(task.id).stage).toBe('Implementing');

    await app.archiveThread.execute({ threadId: thread.id, archived: false });

    expect((await app.getThread.execute(thread.id)).archived).toBe(false);
  });

  it('answers not found for an unknown thread', async () => {
    const app = buildTestApp();

    await expect(
      app.archiveThread.execute({ threadId: 'th-missing', archived: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
