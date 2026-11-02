import { ConfigDtoSchema, ConnectionsDtoSchema } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import { buildTestApp, taskInPrOpen } from '../testing/index.js';

describe('GetConfig', () => {
  it('returns the limits in force, usage by role and task, the repo commands and the profile', async () => {
    const app = buildTestApp({ realRuns: true });
    await taskInPrOpen(app);
    app.repoInfo.found = {
      checkCommands: ['pnpm test'],
      devCommand: null,
      warning: 'AGENTS.md lists no dev command.',
    };
    app.profileFiles.user = {
      path: '/home/owner/.jarvis/USER.md',
      content: 'Reply in Ukrainian.',
      modifiedAt: '2026-01-01T09:30:00.000Z',
    };

    const dto = ConfigDtoSchema.parse(await app.getConfig.execute());

    expect(dto).toMatchObject({
      valid: true,
      path: '/home/owner/.jarvis/jarvis.config.json',
      loadedAt: '2026-01-01T09:00:00.000Z',
      config: { repo: { path: '/jarvis/repo' }, limits: { maxConcurrentWorkers: 1 } },
      usage: {
        todayUsd: 0.5,
        budgetUsd: 20,
        paused: false,
        byRole: { dispatcher: 0, worker: 0.5 },
        byTask: [{ taskId: 'T-1', costUsd: 0.5 }],
      },
      repository: {
        checkCommands: ['pnpm test'],
        devCommand: null,
        warning: 'AGENTS.md lists no dev command.',
      },
      profile: {
        soul: { path: '/jarvis/agent/SOUL.md', content: 'Be brief.' },
        user: { content: 'Reply in Ukrainian.', modifiedAt: '2026-01-01T09:30:00.000Z' },
      },
    });
  });

  it('turns a rejected edit into the error lines instead of the settings (LIM-02)', async () => {
    const app = buildTestApp();
    app.configStatus.error =
      'limits.checkRetries: Too small: expected number to be >=1\n\nrepo.path: Required\n';

    const dto = ConfigDtoSchema.parse(await app.getConfig.execute());

    expect(dto).toEqual({
      valid: false,
      path: '/home/owner/.jarvis/jarvis.config.json',
      errors: ['limits.checkRetries: Too small: expected number to be >=1', 'repo.path: Required'],
    });
  });
});

describe('GetConnections', () => {
  it('probes every connection once and stamps the check time', async () => {
    const app = buildTestApp();
    app.connections.outcomes.set('claude', {
      status: 'ok',
      summary: 'Logged in · Max',
      details: [{ label: 'Version', value: '2.1.309' }],
    });
    app.connections.outcomes.set('slack', {
      status: 'disabled',
      summary: 'Iteration 2.',
      details: [],
    });
    app.connections.outcomes.set('github', {
      status: 'failed',
      summary: 'Check failed: no answer within 10000 ms',
      details: [],
    });

    const dto = ConnectionsDtoSchema.parse(await app.getConnections.execute());

    expect(dto.billingEnvDetected).toBe(false);
    expect(dto.connections.map((c) => [c.id, c.status])).toEqual([
      ['claude', 'ok'],
      ['github', 'failed'],
      ['notion', 'not_configured'],
      ['google_docs', 'not_configured'],
      ['claude_design', 'not_configured'],
      ['slack', 'disabled'],
    ]);
    expect(dto.connections[0]).toEqual({
      id: 'claude',
      status: 'ok',
      summary: 'Logged in · Max',
      details: [{ label: 'Version', value: '2.1.309' }],
      checkedAt: app.clock.now(),
    });
    expect(dto.connections.find((c) => c.id === 'slack')?.checkedAt).toBeNull();
  });

  it('passes the billing warning through (SEC-05)', async () => {
    const app = buildTestApp();
    app.connections.billing = true;

    expect((await app.getConnections.execute()).billingEnvDetected).toBe(true);
  });

  it('reports the explicit subscription flag from the Claude probe', async () => {
    const app = buildTestApp();
    expect((await app.getConnections.execute()).claudeSubscription).toBeNull();

    app.connections.outcomes.set('claude', {
      status: 'failed',
      summary: 'Logged in with api_key',
      subscription: false,
      details: [],
    });
    expect((await app.getConnections.execute()).claudeSubscription).toBe(false);
  });
});
