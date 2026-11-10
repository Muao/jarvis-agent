import { describe, expect, it } from 'vitest';
import { buildTestApp, createTaskInNewThread } from '../testing/index.js';
import { dispatcherMemoryBlock, ownerSections, workerMemoryBlock } from './memory-prompt.js';

const USER = [
  '# About me',
  'Reply in Ukrainian.',
  '',
  '## Learned',
  '',
  '- m1 [owner · 2026-11-01 10:00] Applies everywhere.',
  '- hand-written bullet',
  '',
  '### acme/app',
  '',
  '- m2 [owner · 2026-11-01 10:01] Slug is acme/app.',
  '- m3 [agent · T-1 · 2026-11-02 10:00 · ✓3 ✗0] Use formatDate(). (src: lib/date.ts:12)',
  '',
  '### other/repo',
  '',
  '- m4 [owner · 2026-11-01 10:02] Other repo owner rule.',
  '- m5 [agent · T-2 · 2026-11-02 10:00 · ✓9 ✗0] Other repo agent rule. (src: z.ts:1)',
  '',
  '## After',
  'Tail text.',
  '',
].join('\n');

const app = () => buildTestApp({ realRuns: true });

describe('ownerSections', () => {
  it('is everything outside ## Learned, and never the raw section', () => {
    const text = ownerSections(USER) ?? '';
    expect(text).toContain('Reply in Ukrainian.');
    expect(text).toContain('Tail text.');
    expect(text).not.toContain('Applies everywhere');
    expect(text).not.toContain('Learned');
  });

  it('is null for no file or only a Learned section', () => {
    expect(ownerSections(null)).toBeNull();
    expect(ownerSections('## Learned\n\n- m1 [owner] x\n')).toBeNull();
  });
});

describe('workerMemoryBlock', () => {
  const block = (extra: { softCapChars?: number; present?: boolean } = {}) =>
    workerMemoryBlock({
      content: USER,
      repo: 'acme/app',
      softCapChars: extra.softCapChars ?? 4000,
      fileExists: async () => extra.present ?? true,
    });

  it('has unscoped and this repository entries only, ids visible', async () => {
    const text = (await block()) ?? '';
    expect(text.startsWith('## Memory\n')).toBe(true);
    expect(text).toContain('m1 [owner');
    expect(text).toContain('m2 [owner');
    expect(text).toContain('m3 [agent');
    expect(text).not.toContain('m4');
    expect(text).not.toContain('m5');
  });

  it('marks an agent entry whose cited file is gone, and nothing else', async () => {
    const text = (await block({ present: false })) ?? '';
    expect(text).toContain('(src: lib/date.ts:12) — citation missing');
    expect(text.match(/citation missing/g)).toHaveLength(1);
  });

  it('says so when the cap cut something', async () => {
    const text = (await block({ softCapChars: 150 })) ?? '';
    expect(text).toContain('over its 150-character cap');
    expect(text).not.toContain('m3 [agent');
  });

  it('is null when nothing applies', async () => {
    expect(
      await workerMemoryBlock({
        content: null,
        repo: 'acme/app',
        softCapChars: 4000,
        fileExists: async () => true,
      }),
    ).toBeNull();
  });
});

describe('dispatcherMemoryBlock', () => {
  it('holds owner entries of every scope and no agent entry', () => {
    const text = dispatcherMemoryBlock(USER) ?? '';
    expect(text).toContain('m1 [owner');
    expect(text).toContain('### acme/app');
    expect(text).toContain('m4 [owner');
    expect(text).not.toContain('[agent');
  });
});

describe('first messages built by StartRun', () => {
  it('a worker gets owner sections, then ## Memory; never the raw ## Learned', async () => {
    const a = app();
    a.profile.text = USER;
    a.worktrees.addFile('/jarvis/worktrees/T-1', 'lib/date.ts');

    const { taskId } = await createTaskInNewThread(a);
    const message = a.runner.forTask(taskId)?.spec.firstMessage ?? '';

    expect(message).toContain('## Owner preferences (USER.md)\n# About me\nReply in Ukrainian.');
    expect(message).not.toContain('## Learned');
    expect(message).toContain('## Memory\n');
    expect(message).toContain('m3 [agent');
    expect(message).not.toContain('citation missing');
    expect(message).not.toContain('m4');
    expect(message).not.toContain('m5');
    expect(message.indexOf('## Memory')).toBeGreaterThan(message.indexOf('uiCheck:'));
  });

  it('marks a citation whose file is absent from the worktree', async () => {
    const a = app();
    a.profile.text = USER;
    const { taskId } = await createTaskInNewThread(a);
    expect(a.runner.forTask(taskId)?.spec.firstMessage).toContain('citation missing');
  });

  it('a dispatcher gets owner entries only', async () => {
    const a = app();
    a.profile.text = USER;
    const posted = await a.postOwnerMessage.execute({ text: 'hi' });
    const message = a.runner.forThread(posted.threadId, 'dispatcher')?.spec.firstMessage ?? '';

    expect(message).toContain('## Owner preferences (USER.md)');
    expect(message).toContain('## Learned');
    expect(message).toContain('m4 [owner');
    expect(message).not.toContain('[agent');
  });

  it('a ui_check run still receives the memory block', async () => {
    const a = app();
    a.profile.text = USER;
    a.repos.allow('acme/app');
    const { taskId } = await createTaskInNewThread(a, {
      kind: 'ui_check',
      pr: 'acme/app#4',
      repo: 'acme/app',
    });
    const message = a.runner.forTask(taskId)?.spec.firstMessage ?? '';
    expect(message).toContain('taskKind: ui_check');
    expect(message).toContain('## Memory\n');
    expect(message).toContain('m2 [owner');
  });
});
