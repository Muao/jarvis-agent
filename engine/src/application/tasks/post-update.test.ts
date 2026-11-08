import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('PostUpdate', () => {
  it('posts a visible chat line and a journal note, in any stage', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Context' });

    await app.postUpdate.execute(app.identity.worker(task), {
      text: 'reading the repo AGENTS.md and docs now',
    });

    expect(app.messagesOf(thread.id)).toContainEqual(
      expect.objectContaining({
        kind: 'jarvis',
        body: { text: 'reading the repo AGENTS.md and docs now' },
      }),
    );
    expect(app.db.tables.journal).toContainEqual(
      expect.objectContaining({
        taskId: task.id,
        type: 'agent_note',
        data: { text: 'reading the repo AGENTS.md and docs now' },
      }),
    );
  });

  it('refuses a dispatcher run', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await expect(
      app.postUpdate.execute(app.identity.dispatcher(thread.id), { text: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
