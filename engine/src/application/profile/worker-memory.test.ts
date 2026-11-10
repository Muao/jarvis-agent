import { describe, expect, it } from 'vitest';
import { findEntry, memoryEntries, parseMemory } from '../../domain/index.js';
import { ForbiddenError, InvalidInputError } from '../errors.js';
import { buildTestApp, type TestApp } from '../testing/build-test-app.js';

const REPO = { owner: 'burnjohn', name: 'quick-blog' };

async function setup(options: { kind?: 'build' | 'ui_check' } = {}) {
  const app = buildTestApp();
  const seeded = await app.seed.task({
    stage: options.kind === 'ui_check' ? 'Reviewing' : 'Implementing',
    targetRepo: REPO,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.kind === 'ui_check'
      ? { pr: { number: 4, url: 'https://github.com/o/r/pull/4' } }
      : {}),
  });
  const worker = app.identity.worker(seeded.task);
  const worktree = `/jarvis/repos/${REPO.owner}/${REPO.name}/worktrees/${seeded.task.id}`;
  return { app, ...seeded, worker, worktree };
}

const journal = (app: TestApp, taskId: string) =>
  [...app.db.tables.journal.values()].filter((e) => e.taskId === taskId).map((e) => e.type);

describe('NoteInsight', () => {
  it('writes an agent entry under the task repository, at ✓1, and journals it', async () => {
    const { app, task, worker, worktree } = await setup();
    app.worktrees.addFile(worktree, 'lib/date.ts');

    const { id } = await app.noteInsight.execute(worker, {
      fact: 'When formatting dates, use formatDate().',
      citations: ['lib/date.ts:12', 'https://github.com/o/r/pull/41#discussion_r1'],
    });

    const entry = findEntry(parseMemory(app.profile.text ?? ''), id);
    expect(entry).toMatchObject({
      origin: 'agent',
      scope: 'burnjohn/quick-blog',
      task: task.id,
      confirmed: 1,
      contradicted: 0,
    });
    expect(journal(app, task.id)).toContain('memory_noted');
  });

  it('falls back to the configured default repository', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });
    app.worktrees.addFile(`/jarvis/worktrees/${task.id}`, 'a.ts');
    const { id } = await app.noteInsight.execute(app.identity.worker(task), {
      fact: 'x is y',
      citations: ['a.ts:1'],
    });
    expect(findEntry(parseMemory(app.profile.text ?? ''), id)?.scope).toBe('acme/app');
  });

  it('rejects a path:line whose file is not in the worktree, and writes nothing', async () => {
    const { app, task, worker } = await setup();
    await expect(
      app.noteInsight.execute(worker, { fact: 'a fact', citations: ['nope.ts:3'] }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      app.noteInsight.execute(worker, { fact: 'a fact', citations: ['../etc/passwd:1'] }),
    ).rejects.toThrow(InvalidInputError);
    expect(app.profile.text).toBeNull();
    expect(journal(app, task.id)).not.toContain('memory_noted');
  });

  it('rejects a citation that is neither path:line nor a github.com URL', async () => {
    const { app, worker } = await setup();
    await expect(
      app.noteInsight.execute(worker, { fact: 'a fact', citations: ['https://evil.example/x'] }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('is refused for a ui_check task', async () => {
    const { app, worker } = await setup({ kind: 'ui_check' });
    await expect(
      app.noteInsight.execute(worker, { fact: 'a fact', citations: ['https://github.com/o/r'] }),
    ).rejects.toThrow(ForbiddenError);
    expect(app.profile.text).toBeNull();
  });

  it('is worker-only', async () => {
    const { app, thread } = await setup();
    await expect(
      app.noteInsight.execute(app.identity.dispatcher(thread.id), {
        fact: 'a fact',
        citations: ['https://github.com/o/r'],
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

const SEED = [
  '## Learned',
  '',
  '- m1 [owner · 2026-11-01 10:00] Owner rule.',
  '',
  '### burnjohn/quick-blog',
  '',
  '- m2 [agent · T-90 · 2026-11-02 10:00 · ✓1 ✗0] Agent rule. (src: a.ts:1)',
  '',
].join('\n');

describe('ConfirmInsight / ContradictInsight', () => {
  it('counts a task once: the second call writes nothing and says counted: false', async () => {
    const { app, task, worker } = await setup();
    app.profile.text = SEED;

    expect(await app.confirmInsight.execute(worker, { id: 'm2' })).toEqual({
      ok: true,
      confirmed: 2,
      counted: true,
    });
    const after = app.profile.text;
    expect(await app.confirmInsight.execute(worker, { id: 'm2' })).toEqual({
      ok: true,
      confirmed: 2,
      counted: false,
    });
    expect(app.profile.text).toBe(after);
    expect(journal(app, task.id).filter((t) => t === 'memory_confirmed')).toHaveLength(1);
  });

  it('the task that noted an entry cannot confirm it again', async () => {
    const { app, worker, worktree } = await setup();
    app.worktrees.addFile(worktree, 'a.ts');
    const { id } = await app.noteInsight.execute(worker, {
      fact: 'New fact.',
      citations: ['a.ts:1'],
    });
    const before = app.profile.text;

    expect(await app.confirmInsight.execute(worker, { id })).toEqual({
      ok: true,
      confirmed: 1,
      counted: false,
    });
    expect(app.profile.text).toBe(before);
  });

  it('a different task counts again', async () => {
    const { app, worker } = await setup();
    app.profile.text = SEED;
    await app.confirmInsight.execute(worker, { id: 'm2' });
    const other = await app.seed.task({ stage: 'Implementing', targetRepo: REPO });
    const result = await app.confirmInsight.execute(app.identity.worker(other.task), { id: 'm2' });
    expect(result).toMatchObject({ confirmed: 3, counted: true });
  });

  it('contradicts once, keeps the fact byte-identical, and journals the reason', async () => {
    const { app, worker } = await setup();
    app.profile.text = SEED;

    const first = await app.contradictInsight.execute(worker, { id: 'm2', reason: 'file gone' });
    const second = await app.contradictInsight.execute(worker, { id: 'm2', reason: 'again' });

    expect(first).toEqual({ ok: true, contradicted: 1, counted: true });
    expect(second.counted).toBe(false);
    const entry = findEntry(parseMemory(app.profile.text ?? ''), 'm2');
    expect(entry?.fact).toBe('Agent rule.');
    expect(entry?.contradicted).toBe(1);
    const events = [...app.db.tables.journal.values()].filter(
      (e) => e.type === 'memory_contradicted',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ entryId: 'm2', reason: 'file gone' });
  });

  it('contradicting an owner entry changes nothing in the file but tells the thread', async () => {
    const { app, thread, worker } = await setup();
    app.profile.text = SEED;

    const result = await app.contradictInsight.execute(worker, {
      id: 'm1',
      reason: 'code says no',
    });

    expect(app.profile.text).toBe(SEED);
    expect(result).toMatchObject({ ok: true, counted: true });
    const said = app
      .messagesOf(thread.id)
      .filter((m) => m.kind === 'system' && String(m.body.text).includes('m1'));
    expect(said).toHaveLength(1);
    // Twice from one task: the owner is told once.
    await app.contradictInsight.execute(worker, { id: 'm1', reason: 'again' });
    expect(
      app
        .messagesOf(thread.id)
        .filter((m) => m.kind === 'system' && String(m.body.text).includes('m1')),
    ).toHaveLength(1);
  });

  it('confirming an owner entry counts nothing', async () => {
    const { app, worker } = await setup();
    app.profile.text = SEED;
    expect(await app.confirmInsight.execute(worker, { id: 'm1' })).toMatchObject({
      counted: false,
    });
    expect(app.profile.text).toBe(SEED);
  });

  it('an unknown id is an error', async () => {
    const { app, worker } = await setup();
    app.profile.text = SEED;
    await expect(app.confirmInsight.execute(worker, { id: 'm99' })).rejects.toThrow();
  });

  it('both are refused for a ui_check task', async () => {
    const { app, worker } = await setup({ kind: 'ui_check' });
    app.profile.text = SEED;
    await expect(app.confirmInsight.execute(worker, { id: 'm2' })).rejects.toThrow(ForbiddenError);
    await expect(app.contradictInsight.execute(worker, { id: 'm2', reason: 'x' })).rejects.toThrow(
      ForbiddenError,
    );
    expect(app.profile.text).toBe(SEED);
  });
});

describe('RememberOwner', () => {
  it('records an owner entry from a verbatim owner quote, with the message as source', async () => {
    const { app, thread, task, worker } = await setup();
    const posted = await app.postOwnerMessage.execute({
      threadId: thread.id,
      text: 'Please always keep specs under one page, thanks.',
    });

    const { id } = await app.rememberOwner.execute(worker, {
      fact: 'Keep specs under one page.',
      quote: 'keep specs under one page',
    });

    const entry = findEntry(parseMemory(app.profile.text ?? ''), id);
    expect(entry).toMatchObject({
      origin: 'owner',
      scope: 'burnjohn/quick-blog',
      task: task.id,
      source: `message ${posted.messageId}`,
    });
    expect(journal(app, task.id)).toContain('memory_owner_recorded');
  });

  it('everywhere: true makes it unscoped', async () => {
    const { app, thread, worker } = await setup();
    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'in all projects, use tabs' });
    const { id } = await app.rememberOwner.execute(worker, {
      fact: 'Use tabs.',
      quote: 'in all projects, use tabs',
      everywhere: true,
    });
    expect(findEntry(parseMemory(app.profile.text ?? ''), id)?.scope).toBeNull();
  });

  it('rejects a quote that only appears in an agent message', async () => {
    const { app, task, thread, worker } = await setup();
    await app.db.tables.messages.set('m-agent', {
      id: 'm-agent',
      threadId: thread.id,
      taskId: task.id,
      kind: 'jarvis',
      body: { text: 'I will always add semicolons' },
      at: app.clock.now(),
      answer: null,
      answeredAt: null,
    });
    await expect(
      app.rememberOwner.execute(worker, { fact: 'Semicolons.', quote: 'always add semicolons' }),
    ).rejects.toThrow(InvalidInputError);
    expect(app.profile.text).toBeNull();
  });

  it('rejects a quote from a system message or from review text stored as an owner message', async () => {
    const { app, task, thread, worker } = await setup();
    const base = {
      threadId: thread.id,
      taskId: task.id,
      at: app.clock.now(),
      answer: null,
      answeredAt: null,
    };
    app.db.tables.messages.set('m-sys', {
      ...base,
      id: 'm-sys',
      kind: 'system',
      body: { text: 'reviewer said: rename every handler' },
    });
    app.db.tables.messages.set('m-review', {
      ...base,
      id: 'm-review',
      kind: 'owner',
      body: { text: 'please inline the helper function', delivery: 'queued', source: 'review' },
    });
    for (const quote of ['rename every handler', 'inline the helper function']) {
      await expect(app.rememberOwner.execute(worker, { fact: 'A fact.', quote })).rejects.toThrow(
        InvalidInputError,
      );
    }
    expect(memoryEntries(parseMemory(app.profile.text ?? ''))).toHaveLength(0);
  });

  it('rejects a quote shorter than 8 characters', async () => {
    const { app, thread, worker } = await setup();
    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'yes, do it' });
    await expect(
      app.rememberOwner.execute(worker, { fact: 'A fact.', quote: 'do it' }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('is refused for a ui_check task', async () => {
    const { app, thread, worker } = await setup({ kind: 'ui_check' });
    await app.postOwnerMessage.execute({ threadId: thread.id, text: 'always run the linter' });
    await expect(
      app.rememberOwner.execute(worker, { fact: 'Lint.', quote: 'always run the linter' }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('the memory line at the end of a task', () => {
  it('is posted on a terminal transition when the journal holds memory events', async () => {
    const { app, thread, task, worker, worktree } = await setup();
    app.worktrees.addFile(worktree, 'a.ts');
    app.profile.text = SEED;
    await app.noteInsight.execute(worker, { fact: 'New fact.', citations: ['a.ts:1'] });
    await app.confirmInsight.execute(worker, { id: 'm2' });

    await app.cancelTask.execute({ taskId: task.id }, app.identity.dispatcher(thread.id));

    const lines = app
      .messagesOf(thread.id)
      .filter((m) => String(m.body.text).startsWith('Memory:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.body.text).toBe(
      'Memory: 1 noted, 1 confirmed, 0 contradicted — m3 noted; m2 confirmed.',
    );
  });

  it('adds the over-cap notice when the repository memory is cut at that moment', async () => {
    const { app, thread, task, worker } = await setup();
    app.profile.text = SEED;
    await app.confirmInsight.execute(worker, { id: 'm2' });
    app.config.set({ ...app.config.current(), memory: { softCapChars: 40, backupsKept: 20 } });

    await app.cancelTask.execute({ taskId: task.id }, app.identity.dispatcher(thread.id));

    const line = app.messagesOf(thread.id).find((m) => String(m.body.text).startsWith('Memory:'));
    expect(String(line?.body.text)).toMatch(/ Memory is over its cap — ask me to review it\.$/);
  });

  it('has no over-cap notice while everything fits', async () => {
    const { app, thread, task, worker } = await setup();
    app.profile.text = SEED;
    await app.confirmInsight.execute(worker, { id: 'm2' });

    await app.cancelTask.execute({ taskId: task.id }, app.identity.dispatcher(thread.id));

    const line = app.messagesOf(thread.id).find((m) => String(m.body.text).startsWith('Memory:'));
    expect(String(line?.body.text)).not.toContain('over its cap');
  });

  it('is not posted when the task never touched the memory', async () => {
    const { app, thread, task } = await setup();
    await app.cancelTask.execute({ taskId: task.id }, app.identity.dispatcher(thread.id));
    expect(
      app.messagesOf(thread.id).filter((m) => String(m.body.text).startsWith('Memory:')),
    ).toHaveLength(0);
  });
});
