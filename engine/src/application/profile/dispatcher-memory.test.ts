import { describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

const FILE = [
  '# Owner',
  'Reply in Ukrainian.',
  '',
  '## Learned',
  '',
  '- m1 [owner · 2026-11-01 10:00] Slug is a/b.',
  '- m2 [owner · 2026-11-01 10:01] Specs stay short.',
  '',
  '### a/b',
  '',
  '- m3 [agent · T-1 · 2026-11-02 10:00 · ✓1 ✗0] Use formatDate(). (src: lib/date.ts:1)',
  '- m4 [agent · T-2 · 2026-11-03 10:00 · ✓2 ✗0] Run db:seed first. (src: package.json:3)',
  '',
  '### c/d',
  '',
  '- m5 [agent · T-3 · 2026-11-04 10:00 · ✓1 ✗0] Other repo. (src: x.ts:1)',
  '',
].join('\n');

describe('forget, merge_insights, read_memory', () => {
  it('forget removes one entry, takes a backup, and is dispatcher-only', async () => {
    const app = buildTestApp();
    app.profile.text = FILE;
    const thread = await app.seed.thread();

    await app.forget.execute(app.identity.dispatcher(thread.id), { id: 'm2' });

    expect(app.profile.text).not.toContain('m2 [');
    expect(app.profile.text).toContain('Reply in Ukrainian.');
    expect(app.profile.backups).toEqual([FILE]);
    expect(app.logger.infos.find((l) => l.context.event === 'memory.forgotten')).toMatchObject({
      context: { entryId: 'm2', fact: 'Specs stay short.' },
    });
    const { task } = await app.seed.task({ stage: 'Implementing' });
    await expect(app.forget.execute(app.identity.worker(task), { id: 'm1' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('forget of an unknown id is a not-found error and writes nothing', async () => {
    const app = buildTestApp();
    app.profile.text = FILE;
    const thread = await app.seed.thread();
    await expect(
      app.forget.execute(app.identity.dispatcher(thread.id), { id: 'm99' }),
    ).rejects.toThrow(NotFoundError);
    expect(app.profile.text).toBe(FILE);
  });

  it('merge_insights sums the counters, backs up, and refuses mixed scopes', async () => {
    const app = buildTestApp();
    app.profile.text = FILE;
    const thread = await app.seed.thread();
    const dispatcher = app.identity.dispatcher(thread.id);

    const { id } = await app.mergeInsights.execute(dispatcher, {
      ids: ['m3', 'm4'],
      fact: 'Dates via formatDate(); seed the db first.',
    });

    expect(app.profile.text).toContain(`${id} [agent · T-1 · 2026-11-02 10:00 · ✓3 ✗0`);
    expect(app.profile.backups).toHaveLength(1);
    expect(app.logger.infos.find((l) => l.context.event === 'memory.merged')).toMatchObject({
      context: {
        entryId: id,
        from: [
          { id: 'm3', fact: 'Use formatDate().' },
          { id: 'm4', fact: 'Run db:seed first.' },
        ],
      },
    });
    await expect(
      app.mergeInsights.execute(dispatcher, { ids: ['m1', 'm5'], fact: 'mixed' }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('read_memory numbers hand-written lines so every entry it shows has an id', async () => {
    const app = buildTestApp();
    app.profile.text =
      '# Me\n\n## Learned\n\n- hand written\n- m4 [owner · 2026-11-01 10:00] Numbered.\n';
    const thread = await app.seed.thread();

    const { text } = await app.readMemory.execute(app.identity.dispatcher(thread.id));

    expect(text).toContain('- m5 [owner] hand written');
    expect(app.profile.text).toContain('- m5 [owner] hand written');
    expect(app.profile.text?.startsWith('# Me\n\n## Learned')).toBe(true);
    await app.forget.execute(app.identity.dispatcher(thread.id), { id: 'm5' });
    expect(app.profile.text).not.toContain('hand written');
  });

  it('read_memory returns the whole section, agent entries included', async () => {
    const app = buildTestApp();
    app.profile.text = FILE;
    const thread = await app.seed.thread();

    const { text } = await app.readMemory.execute(app.identity.dispatcher(thread.id));

    expect(text.startsWith('## Learned')).toBe(true);
    expect(text).toContain('m5 [agent');
    expect(text).not.toContain('Reply in Ukrainian.');
  });
});
