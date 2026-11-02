import { diffPullRequest, type PullRequestSnapshot } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ThreadMessages } from '../conversation/thread-messages.js';
import type { Clock } from '../ports/clock.js';
import type { CodeHost } from '../ports/code-host.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { Watch } from '../ports/watch-repository.js';
import { transact, type TransactionDeps } from '../transaction.js';
import type { HandleCodeHostChange } from './handle-code-host-change.js';
import { buildSummary } from './watch-summary.js';

interface Rerun {
  readonly taskId: string;
  readonly prNumber: number;
  readonly headSha: string;
}

/**
 * One watcher tick (CI-01, CI-02, CI-07, CI-09), called by the timer every `watch.pollSeconds`.
 * For each open PR: read the snapshot, diff it against what was processed, and handle the changes
 * together with the new state in one transaction. A poll that finds nothing changes no task,
 * writes no message and starts no run. One PR failing does not stop the others.
 */
export class PollPullRequests {
  constructor(
    private readonly deps: TransactionDeps & {
      readonly clock: Clock;
      readonly config: ConfigProvider;
      readonly codeHost: CodeHost;
      readonly handler: HandleCodeHostChange;
      readonly messages: ThreadMessages;
    },
  ) {}

  async execute(): Promise<void> {
    const { uow, notifiers } = this.deps;
    const watches = await uow.run((tx) => tx.watches.listActive());
    if (watches.length === 0) return;
    let botLogin: string;
    try {
      botLogin = await this.deps.codeHost.botLogin();
    } catch (error) {
      notifiers.logger.error('watcher could not read the bot login', describe(error));
      return;
    }
    for (const watch of watches) {
      try {
        await this.pollOne(watch, botLogin);
      } catch (error) {
        notifiers.logger.error('watcher failed for a PR', {
          taskId: watch.taskId,
          prNumber: watch.prNumber,
          ...describe(error),
        });
      }
    }
  }

  private async pollOne(watch: Watch, botLogin: string): Promise<void> {
    const { uow, codeHost } = this.deps;
    // Only a task waiting on its PR is judged. While the worker fixes (Fixing) the state stays as it
    // was, so what happened on the new head is still new when the task is back in PR Open.
    const waiting = await uow.run(
      async (tx) => (await tx.tasks.get(watch.taskId))?.stage === 'PR Open',
    );
    if (!waiting) return;

    const snapshot = await codeHost.snapshot(watch.prNumber);
    const rerun = await this.apply(watch, snapshot, botLogin);
    if (rerun !== null) await this.rerun(rerun);
  }

  private apply(
    watch: Watch,
    snapshot: PullRequestSnapshot,
    botLogin: string,
  ): Promise<Rerun | null> {
    const { clock, config, handler } = this.deps;
    return transact(this.deps, async (tx, outbox): Promise<Rerun | null> => {
      // Read again inside the transaction: the task may have moved while the snapshot was fetched.
      const current = await tx.watches.get(watch.taskId);
      const task = await tx.tasks.get(watch.taskId);
      if (current === null || task === null || task.stage !== 'PR Open' || task.pr === null) {
        return null;
      }
      if (current.prNumber !== watch.prNumber) return null;

      const context = { botLogin, reviewers: config.current().allowlist.githubReviewers };
      const diff = diffPullRequest(current.state, snapshot, context);
      const { summary, approvedBy } = buildSummary({
        previous: current.summary,
        snapshot,
        diff,
        context,
      });
      const handled =
        diff.changes.length === 0 && diff.ignored.length === 0
          ? null
          : await handler.handle(tx, outbox, { task, watch: current, diff, summary, approvedBy });

      await tx.watches.save({
        ...current,
        state: diff.next,
        lastCheckedAt: clock.now(),
        summary,
        ...(handled === null
          ? {}
          : { lastGreen: handled.lastGreen, rerunHeadSha: handled.rerunHeadSha }),
      });
      if (JSON.stringify(summary) !== JSON.stringify(current.summary)) outbox.taskChanged(task);
      return handled?.rerun == null ? null : { taskId: task.id, ...handled.rerun };
    });
  }

  /**
   * Runs after the commit, because the host call cannot be rolled back. If it fails, the red result
   * is handled as a real failure: the stored check state is cleared so the next tick reports it again,
   * and a head is only ever re-run once.
   */
  private async rerun(rerun: Rerun): Promise<void> {
    const { codeHost, notifiers, messages } = this.deps;
    try {
      await codeHost.rerunFailedChecks(rerun.prNumber, rerun.headSha);
    } catch (error) {
      notifiers.logger.error('could not re-run failed checks', { ...rerun, ...describe(error) });
      await transact(this.deps, async (tx, outbox) => {
        const watch = await tx.watches.get(rerun.taskId);
        const task = await tx.tasks.get(rerun.taskId);
        if (watch?.state?.headSha !== rerun.headSha || task === null) return;
        await tx.watches.save({ ...watch, state: { ...watch.state, checks: [] } });
        const body: BodyOf<'system'> = {
          text: 'Could not re-run the checks — treating the failure as real.',
        };
        await messages.post(tx, outbox, {
          threadId: task.threadId,
          taskId: task.id,
          kind: 'system',
          body,
        });
      });
    }
  }
}

function describe(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}
