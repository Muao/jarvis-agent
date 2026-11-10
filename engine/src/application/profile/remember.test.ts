import { describe, expect, it } from 'vitest';
import { memoryEntries, parseMemory } from '../../domain/index.js';
import { ForbiddenError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('Remember', () => {
  it('appends the fact through the profile store', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await app.remember.execute(app.identity.dispatcher(thread.id), {
      fact: 'the QuickBlog repo is burnjohn/quick-blog',
    });

    expect(app.profile.learned).toEqual(['the QuickBlog repo is burnjohn/quick-blog']);
  });

  it('writes under the repository subheading when given a repo, and returns the id', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    const { id } = await app.remember.execute(app.identity.dispatcher(thread.id), {
      fact: 'specs stay under one page',
      repo: 'burnjohn/quick-blog',
    });

    const [entry] = memoryEntries(parseMemory(app.profile.text ?? ''));
    expect(entry).toMatchObject({ id, origin: 'owner', scope: 'burnjohn/quick-blog' });
  });

  it('is dispatcher-only', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await expect(
      app.remember.execute(app.identity.worker(task), { fact: 'anything' }),
    ).rejects.toThrow(ForbiddenError);
    expect(app.profile.learned).toEqual([]);
  });
});
