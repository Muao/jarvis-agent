import { recordCheckFailure } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import { transact } from '../transaction.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';

export interface ReportChecksInput {
  readonly passed: boolean;
  readonly summary: string;
}

/** What the worker is told: keep going, fix and run the checks again, or stop because the task failed. */
export type ChecksOutcome =
  | { readonly outcome: 'passed' }
  | { readonly outcome: 'retry'; readonly attempt: number; readonly max: number }
  | { readonly outcome: 'failed'; readonly max: number };

/** WRK-07: a red check is retried up to `limits.checkRetries` times, then the task fails. */
export class ReportChecks {
  constructor(private readonly deps: TaskDeps & { readonly config: ConfigProvider }) {}

  execute(identity: RunIdentity, input: ReportChecksInput): Promise<ChecksOutcome> {
    return transact(this.deps, async (tx, outbox): Promise<ChecksOutcome> => {
      const task = await loadWorkerTask(tx, identity);
      const { writer } = this.deps;
      if (input.passed) {
        await writer.note(tx, task.id, 'checks_passed', 'agent', { summary: input.summary });
        return { outcome: 'passed' };
      }

      const { limits } = this.deps.config.current();
      const recorded = recordCheckFailure(task, limits);
      const data = { summary: input.summary, max: limits.checkRetries };
      if (recorded.outcome === 'retry') {
        const attempt = recorded.task.counters.checkRetries;
        await writer.update(tx, outbox, recorded.task, 'checks_failed', 'agent', {
          ...data,
          attempt,
        });
        return { outcome: 'retry', attempt, max: limits.checkRetries };
      }

      await writer.note(tx, task.id, 'checks_failed', 'agent', {
        ...data,
        attempt: task.counters.checkRetries,
      });
      const reason = `Checks still failing after ${limits.checkRetries} retries: ${input.summary}`;
      const failed = await writer.move(tx, outbox, task, 'Failed', {
        cause: 'checks_exhausted',
        reason,
      });
      const body: BodyOf<'system'> = { text: `Task ${failed.id} failed. ${reason}` };
      await this.deps.messages.post(tx, outbox, {
        threadId: failed.threadId,
        taskId: failed.id,
        kind: 'system',
        body,
      });
      outbox.stopTaskRuns(failed.id);
      return { outcome: 'failed', max: limits.checkRetries };
    });
  }
}
