import { describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidInputError } from '../errors.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('UpdateConfig', () => {
  it('merges a valid patch into limits and leaves the other limits fields untouched', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    const before = app.config.current().limits;

    const result = await app.updateConfig.execute(app.identity.dispatcher(thread.id), {
      patch: { limits: { stallMinutes: 1 } },
    });

    expect(result.limits).toEqual({ ...before, stallMinutes: 1 });
    expect(app.config.current().limits).toEqual({ ...before, stallMinutes: 1 });
  });

  it('journals a successful call into the thread', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    await app.updateConfig.execute(app.identity.dispatcher(thread.id), {
      patch: { limits: { stallMinutes: 1 } },
    });

    const posted = app.messagesOf(thread.id).at(-1);
    expect(posted?.kind).toBe('jarvis');
    expect(JSON.stringify(posted?.body)).toContain('stallMinutes');
  });

  it.each([
    { repo: { path: '/somewhere/else' } },
    { repo: { remote: 'upstream' } },
    { repo: { baseBranch: 'develop' } },
    { repos: { allow: ['owner/name'] } },
    { repos: { allowOwnerRepos: true } },
    { repos: { allowSelf: true } },
    { engine: { port: 9999 } },
    { engine: { claudeBinary: '/usr/bin/claude' } },
  ])('rejects a patch touching %j, and writes nothing', async (patch) => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    const before = app.config.current();

    await expect(
      app.updateConfig.execute(app.identity.dispatcher(thread.id), { patch }),
    ).rejects.toThrow(InvalidInputError);

    expect(app.config.current()).toEqual(before);
    expect(app.messagesOf(thread.id)).toHaveLength(0);
  });

  it('rejects a patch that fails schema validation, and writes nothing', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    const before = app.config.current();

    await expect(
      app.updateConfig.execute(app.identity.dispatcher(thread.id), {
        patch: { limits: { maxBudgetUsdPerRun: -1 } },
      }),
    ).rejects.toThrow(InvalidInputError);

    expect(app.config.current()).toEqual(before);
    expect(app.messagesOf(thread.id)).toHaveLength(0);
  });

  it('rejects the whole call when a forbidden field is mixed with an otherwise valid one', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    const before = app.config.current();

    await expect(
      app.updateConfig.execute(app.identity.dispatcher(thread.id), {
        patch: { limits: { stallMinutes: 1 }, engine: { port: 9999 } },
      }),
    ).rejects.toThrow(InvalidInputError);

    expect(app.config.current()).toEqual(before);
    expect(app.messagesOf(thread.id)).toHaveLength(0);
  });

  it('refuses to edit allowlist.githubReviewers from chat (ADR-0018)', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    const before = app.config.current();

    await expect(
      app.updateConfig.execute(app.identity.dispatcher(thread.id), {
        patch: { allowlist: { githubReviewers: ['stranger'] } },
      }),
    ).rejects.toThrow(InvalidInputError);

    // It decides whose pull request runs its code here without a permission card.
    expect(app.config.current()).toEqual(before);
    expect(app.messagesOf(thread.id)).toHaveLength(0);
  });

  it('refuses to edit ui.defaultImage, ui.noSandbox or ui.paths from chat (AC-3)', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();
    const before = app.config.current();

    for (const patch of [
      { ui: { defaultImage: 'evil/image' } },
      { ui: { noSandbox: true } },
      { ui: { paths: ['**/*'] } },
      { ui: { enabled: true, defaultImage: 'evil/image' } },
      // The only gate before writing to a pull request.
      { ui: { autoApproveComments: true } },
    ]) {
      await expect(
        app.updateConfig.execute(app.identity.dispatcher(thread.id), { patch }),
      ).rejects.toThrow(InvalidInputError);
    }

    expect(app.config.current()).toEqual(before);
    expect(app.messagesOf(thread.id)).toHaveLength(0);
  });

  it('still allows the editable ui fields', async () => {
    const app = buildTestApp();
    const thread = await app.seed.thread();

    const config = await app.updateConfig.execute(app.identity.dispatcher(thread.id), {
      patch: { ui: { enabled: true, maxScenarios: 3 } },
    });

    expect(config.ui.enabled).toBe(true);
    expect(config.ui.maxScenarios).toBe(3);
    expect(config.ui.defaultImage).toBe('node:22-bookworm');
  });

  it('is dispatcher-only', async () => {
    const app = buildTestApp();
    const { task } = await app.seed.task({ stage: 'Implementing' });

    await expect(
      app.updateConfig.execute(app.identity.worker(task), {
        patch: { limits: { stallMinutes: 1 } },
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});
