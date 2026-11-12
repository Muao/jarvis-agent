import { basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentPlanSchema, type UiCheckReport } from '@jarvis/shared';
import { buildTestApp } from '../testing/build-test-app.js';
import type { UiBrowser } from '../ports/ui-browser.js';

const plan = EnvironmentPlanSchema.parse({ app: { command: 'npm run dev', port: 5173 } });

async function fixture() {
  const browser = {
    call: vi.fn<UiBrowser['call']>(async (input) => ({
      content: [{ type: 'text', text: 'button works' }],
      evidence: [`screenshots/${basename(input.outputDir)}/screen.png`],
    })),
    close: vi.fn(async () => {}),
  };
  const app = buildTestApp({ uiBrowser: browser });
  const { task } = await app.seed.task({ stage: 'Reviewing' });
  const identity = app.identity.worker(task);
  const start = await app.startDevServer.execute(identity, plan);
  if (!start.ok || !('checkId' in start)) throw new Error('expected a leased check');
  const checkId = String(start.checkId);
  const evidence = `screenshots/${checkId}/screen.png`;
  app.artifacts.writeImage(task.id, evidence, new Uint8Array([1, 2, 3]));
  const report: UiCheckReport = {
    checkId,
    status: 'passed',
    summary: 'Button works',
    scenarios: [
      {
        criterion: 'Button increments',
        expected: '1',
        observed: '1',
        status: 'passed',
        evidence: [evidence],
      },
    ],
  };
  const browse = () =>
    app.uiVerification.browse(identity, {
      checkId,
      tool: 'browser_take_screenshot',
      arguments: {},
    });
  const stop = () => app.stopDevServer.execute(identity);
  return { app, task, identity, browser, checkId, report, browse, stop };
}

describe('confirmed UI verification', () => {
  it('records a commit-bound pass only after browser activity and cleanup; retries are idempotent', async () => {
    const { app, identity, browser, report, browse, stop } = await fixture();
    await browse();
    await stop();
    const result = await app.uiVerification.report(identity, report);
    expect(result).toMatchObject({
      ok: true,
      status: 'passed',
      headSha: await app.branchPublisher.headSha(),
    });
    expect(await app.uiVerification.report(identity, report)).toEqual(result);
    expect(app.db.tables.journal.filter((e) => e.type === 'ui_check_completed')).toHaveLength(1);
    expect(browser.close).toHaveBeenCalledWith(identity.runId);
    expect(app.devServers.current()).toBeNull();
    app.branchPublisher.sha = 'b'.repeat(40);
    await expect(app.uiVerification.report(identity, report)).rejects.toThrow('HEAD changed');
  });

  it('refuses server startup alone and screenshots not observed through the browser', async () => {
    const { app, identity, report, browse, stop } = await fixture();
    await expect(app.uiVerification.report(identity, report)).rejects.toThrow('No confirmed');
    await browse();
    await stop();
    const forged = {
      ...report,
      scenarios: report.scenarios.map((s) => ({ ...s, evidence: ['other.png'] })),
    };
    await expect(app.uiVerification.report(identity, forged)).rejects.toThrow('another check');
  });

  it('does not count tool listing as browser verification', async () => {
    const { app, identity, checkId, report, stop } = await fixture();
    await app.uiVerification.browse(identity, { checkId, tool: 'list', arguments: {} });
    await stop();
    await expect(app.uiVerification.report(identity, report)).rejects.toThrow('No confirmed');
  });

  it('rejects foreign runs and dispatchers', async () => {
    const { app, identity, report, checkId } = await fixture();
    await expect(
      app.uiVerification.browse(
        { ...identity, runId: 'other' },
        { checkId, tool: 'browser_snapshot', arguments: {} },
      ),
    ).rejects.toThrow('foreign');
    await expect(
      app.uiVerification.report({ ...identity, role: 'dispatcher' }, report),
    ).rejects.toThrow('worker');
    await app.uiVerification.cleanup(identity.taskId!);
  });

  it('does not accept an old commit or dirty worktree', async () => {
    const { app, identity, report, browse, stop } = await fixture();
    await browse();
    await stop();
    app.branchPublisher.sha = 'b'.repeat(40);
    await expect(app.uiVerification.report(identity, report)).rejects.toThrow('HEAD changed');
    app.branchPublisher.state = { ...app.branchPublisher.state, dirtyFiles: ['web/a.tsx'] };
    await expect(app.uiVerification.report(identity, report)).rejects.toThrow('Commit changes');
  });

  it('records unavailable explicitly and cannot rewrite a completed failure to success', async () => {
    const { app, identity, report, browse, stop } = await fixture();
    await browse();
    await stop();
    const failed: UiCheckReport = {
      ...report,
      status: 'failed',
      scenarios: report.scenarios.map((s) => ({ ...s, status: 'failed' })),
    };
    expect(await app.uiVerification.report(identity, failed)).toMatchObject({ status: 'failed' });
    await expect(app.uiVerification.report(identity, report)).rejects.toThrow('already completed');
    expect(
      await app.uiVerification.report(identity, {
        status: 'unavailable',
        summary: 'No Docker',
        reason: 'daemon offline',
        scenarios: [],
      }),
    ).toMatchObject({ status: 'unavailable' });
  });

  it.each(['error-value', 'exception', 'cleanup'])(
    'never passes after %s and still releases resources',
    async (mode) => {
      const { app, task, identity, browser, report, browse, stop } = await fixture();
      if (mode === 'error-value')
        browser.call.mockResolvedValueOnce({ content: [], isError: true });
      if (mode === 'exception') browser.call.mockRejectedValueOnce(new Error('browser crashed'));
      if (mode === 'cleanup') browser.close.mockRejectedValueOnce(new Error('cannot close'));
      await browse().catch(() => {});
      await stop().catch(() => {});
      expect(app.devServers.stopped).toContain(task.id);
      await expect(app.uiVerification.report(identity, report)).rejects.toThrow('No confirmed');
      await app.uiVerification.cleanup(task.id);
    },
  );

  it('rejects missing/empty evidence', async () => {
    const { app, task, identity, report, browse, stop } = await fixture();
    await browse();
    await stop();
    app.artifacts.writeImage(task.id, report.scenarios[0]!.evidence[0]!, new Uint8Array());
    await expect(app.uiVerification.report(identity, report)).rejects.toThrow('Empty');
  });

  it('cleans up a startup that finishes after cancellation', async () => {
    const { app, task, identity } = await fixture();
    await app.stopDevServer.execute(identity);
    const original = app.devServers.start.bind(app.devServers);
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(app.devServers, 'start').mockImplementation(async (...args) => {
      entered();
      await waiting;
      return original(...args);
    });
    const pending = app.startDevServer.execute(identity, plan);
    await started;
    const cleanup = app.uiVerification.cleanup(task.id);
    finish();
    await expect(pending).rejects.toThrow('Run ended');
    await cleanup;
    expect(app.devServers.current()).toBeNull();
  });

  it('run exit/shutdown invalidate ownership and release browser/server', async () => {
    const { app, task, identity, report, browser } = await fixture();
    await app.uiVerification.closeAll();
    expect(browser.close).toHaveBeenCalled();
    expect(app.devServers.current()).toBeNull();
    await expect(app.uiVerification.report(identity, report)).rejects.toThrow('Unknown');
    expect(app.devServers.stopped).toContain(task.id);
  });

  it('lease expiry releases the browser too and prevents late results', async () => {
    vi.useFakeTimers();
    try {
      const { app, task, identity, report, browser } = await fixture();
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(browser.close).toHaveBeenCalled();
      expect(app.devServers.current()).toBeNull();
      await expect(app.uiVerification.report(identity, report)).rejects.toThrow('Unknown');
      expect(app.devServers.stopped).toContain(task.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
