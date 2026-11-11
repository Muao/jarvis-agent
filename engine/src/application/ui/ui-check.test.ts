import { EnvironmentPlanSchema, JarvisConfigSchema, toolInputSchemas } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.js';
import { buildTestApp, type TestApp } from '../testing/index.js';
import { ATTACHED } from './attach-image.js';

/** A minimal environment plan, as the worker would compose it from the repository. */
const PLAN = EnvironmentPlanSchema.parse({
  prepare: ['npm ci'],
  app: { command: 'npm run dev -- --host 0.0.0.0', port: 5173 },
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The UI check is off by default; every test here turns it on explicitly. */
function enableUi(app: TestApp, overrides: Record<string, unknown> = {}): void {
  app.config.set(
    JarvisConfigSchema.parse({
      repo: { path: '/jarvis/repo' },
      ui: { enabled: true, ...overrides },
    }),
  );
}

/** The journal event types of one task, oldest first. */
function journalOf(app: TestApp, taskId: string): string[] {
  return app.db.tables.journal.filter((e) => e.taskId === taskId).map((e) => e.type);
}

async function reviewing(app: TestApp) {
  const { task } = await app.seed.task({ stage: 'Reviewing' });
  return task;
}

describe('start_dev_server (ADR-0014)', () => {
  it("starts the worker's plan from the task worktree and journals it (AC-8)", async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);

    const result = await app.startDevServer.execute(app.identity.worker(task), PLAN);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.lease.baseUrl).toBe('http://127.0.0.1:5173');
    expect(app.devServers.started).toEqual([
      { taskId: task.id, cwd: `/jarvis/worktrees/${task.id}`, plan: PLAN },
    ]);
    expect(journalOf(app, task.id)).toContain('dev_server_started');
  });

  it('takes a plan and nothing else: no mounts, no flags, no task to act for', () => {
    const { start_dev_server: start, stop_dev_server: stop } = toolInputSchemas;
    expect(start.safeParse({ plan: PLAN }).success).toBe(true);
    expect(start.safeParse({}).success).toBe(false);
    expect(start.safeParse({ plan: { ...PLAN, volumes: ['/:/host'] } }).success).toBe(false);
    expect(start.safeParse({ plan: PLAN, taskId: 'T-2' }).success).toBe(false);
    expect(stop.safeParse({ taskId: 'T-2' }).success).toBe(false);
  });

  it('refuses a plan that carries a literal credential, before anything runs', async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);
    const plan = EnvironmentPlanSchema.parse({ ...PLAN, env: { JWT_SECRET: 'dev-secret' } });

    const result = await app.startDevServer.execute(app.identity.worker(task), plan);

    expect(result).toMatchObject({ ok: false, reason: 'invalid_plan' });
    expect(app.devServers.started).toHaveLength(0);
    expect(journalOf(app, task.id)).toContain('dev_server_refused');
  });

  it('lets one run try ui.maxStartAttempts plans and no more', async () => {
    const app = buildTestApp();
    enableUi(app, { maxStartAttempts: 2 });
    const task = await reviewing(app);
    app.devServers.nextResult = { ok: false, reason: 'step_failed', detail: 'npm ci failed' };
    const worker = app.identity.worker(task);

    await app.startDevServer.execute(worker, PLAN);
    await app.startDevServer.execute(worker, PLAN);
    const third = await app.startDevServer.execute(worker, PLAN);

    expect(third).toMatchObject({ ok: false, reason: 'attempts_exhausted' });
    expect(app.devServers.started).toHaveLength(2);
  });

  it('is refused outside Reviewing', async () => {
    const app = buildTestApp();
    enableUi(app);
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await expect(app.startDevServer.execute(app.identity.worker(task), PLAN)).rejects.toThrow(
      ForbiddenError,
    );
    expect(app.devServers.started).toHaveLength(0);
  });

  it('is refused for the dispatcher', async () => {
    const app = buildTestApp();
    enableUi(app);
    const thread = await app.seed.thread();

    await expect(
      app.startDevServer.execute(app.identity.dispatcher(thread.id), PLAN),
    ).rejects.toThrow(ForbiddenError);
  });

  it('passes a refusal through and journals its reason (AC-9, AC-10, AC-15)', async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);
    app.devServers.nextResult = {
      ok: false,
      reason: 'port_busy',
      detail: 'http://127.0.0.1:5173 already answers.',
    };

    const result = await app.startDevServer.execute(app.identity.worker(task), PLAN);

    expect(result).toMatchObject({ ok: false, reason: 'port_busy' });
    expect(journalOf(app, task.id)).toContain('dev_server_refused');
  });
});

describe('stop_dev_server (ADR-0014)', () => {
  it('stops the lease the task holds', async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);
    await app.startDevServer.execute(app.identity.worker(task), PLAN);

    expect(await app.stopDevServer.execute(app.identity.worker(task))).toEqual({ stopped: true });
    expect(app.devServers.stopped).toEqual([task.id]);
  });

  it('is a no-op for a task that holds no lease', async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);

    expect(await app.stopDevServer.execute(app.identity.worker(task))).toEqual({ stopped: false });
  });
});

describe('attach_image (ADR-0014)', () => {
  const attach = (app: TestApp, task: { id: string; threadId: string }, path: string) =>
    app.attachImage.execute(app.identity.worker(task as never), { path, alt: 'the task card' });

  it('uploads the screenshot and returns markdown to paste into the PR (AC-18)', async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);
    app.artifacts.writeImage(task.id, 'screenshots/001-card.png', PNG);

    const result = await attach(app, task, 'screenshots/001-card.png');

    expect(result).toEqual({
      ok: true,
      url: 'https://github.com/user-attachments/assets/u1',
      markdown: '![the task card](https://github.com/user-attachments/assets/u1)',
    });
    expect(app.codeHost.uploads[0]).toMatchObject({
      name: '001-card.png',
      contentType: 'image/png',
    });
    expect(journalOf(app, task.id).filter((type) => type === ATTACHED)).toHaveLength(1);
  });

  it('refuses a path outside the artifacts directory before touching GitHub (AC-16)', async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);

    const result = await attach(app, task, '../../etc/shadow.png');

    expect(result).toMatchObject({ ok: false });
    expect(app.codeHost.uploads).toHaveLength(0);
  });

  it('refuses a file that is not an image (AC-17)', async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);

    const result = await attach(app, task, 'spec.md');

    expect(result).toMatchObject({ ok: false });
    expect(app.codeHost.uploads).toHaveLength(0);
  });

  it('refuses a file over ui.maxImageMb (AC-17)', async () => {
    const app = buildTestApp();
    enableUi(app, { maxImageMb: 1 });
    const task = await reviewing(app);
    app.artifacts.writeImage(task.id, 'big.png', new Uint8Array(2 * 1024 * 1024));

    const result = await attach(app, task, 'big.png');

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('the limit is 1 MB');
    expect(app.codeHost.uploads).toHaveLength(0);
  });

  it('refuses an empty screenshot', async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);
    app.artifacts.writeImage(task.id, 'empty.png', new Uint8Array(0));

    expect(await attach(app, task, 'empty.png')).toMatchObject({ ok: false });
    expect(app.codeHost.uploads).toHaveLength(0);
  });

  it('stops at ui.maxScreenshots (AC-20)', async () => {
    const app = buildTestApp();
    enableUi(app, { maxScreenshots: 2 });
    const task = await reviewing(app);
    for (const name of ['a.png', 'b.png', 'c.png']) {
      app.artifacts.writeImage(task.id, name, PNG);
    }

    expect((await attach(app, task, 'a.png')).ok).toBe(true);
    expect((await attach(app, task, 'b.png')).ok).toBe(true);
    const third = await attach(app, task, 'c.png');

    expect(third).toMatchObject({ ok: false });
    if (third.ok) throw new Error('expected a refusal');
    expect(third.reason).toContain('screenshot_limit_reached');
    expect(app.codeHost.uploads).toHaveLength(2);
  });

  it('refuses while ui.attachToPr is false (AC-21)', async () => {
    const app = buildTestApp();
    enableUi(app, { attachToPr: false });
    const task = await reviewing(app);
    app.artifacts.writeImage(task.id, 'a.png', PNG);

    const result = await attach(app, task, 'a.png');

    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('attachments_disabled');
    expect(app.codeHost.uploads).toHaveLength(0);
  });

  it("passes GitHub's refusal through and journals it, without consuming the quota (AC-19)", async () => {
    const app = buildTestApp();
    enableUi(app);
    const task = await reviewing(app);
    app.artifacts.writeImage(task.id, 'a.png', PNG);
    app.codeHost.uploadResult = { ok: false, reason: 'GitHub refused the upload with 404.' };

    const result = await attach(app, task, 'a.png');

    expect(result).toEqual({ ok: false, reason: 'GitHub refused the upload with 404.' });
    const journal = journalOf(app, task.id);
    expect(journal).toContain('ui_screenshot_attach_failed');
    expect(journal.filter((type) => type === ATTACHED)).toHaveLength(0);
  });

  it('is refused for the dispatcher', async () => {
    const app = buildTestApp();
    enableUi(app);
    const thread = await app.seed.thread();

    await expect(
      app.attachImage.execute(app.identity.dispatcher(thread.id), { path: 'a.png', alt: 'x' }),
    ).rejects.toThrow(ForbiddenError);
  });
});
