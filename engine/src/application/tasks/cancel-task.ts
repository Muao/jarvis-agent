import type { BodyOf } from '../conversation/message-bodies.js';
import { transact } from '../transaction.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadTask, requireDispatcher } from './guards.js';

export interface CancelTaskInput {
  readonly taskId: string;
  readonly reason?: string;
}

/**
 * DSP-06: stop the task's runs and mark it Cancelled; tell the thread what is left behind.
 * Called by the owner (HTTP, no identity) or by the dispatcher tool (identity required).
 */
export class CancelTask {
  constructor(private readonly deps: TaskDeps) {}

  async execute(input: CancelTaskInput, identity?: RunIdentity): Promise<void> {
    if (identity !== undefined) requireDispatcher(identity);
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadTask(tx, input.taskId);
      const cancelled = await this.deps.writer.move(tx, outbox, task, 'Cancelled', {
        cause: 'owner_cancelled',
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      const left = [`branch ${cancelled.branch}`];
      if (cancelled.pr !== null) left.push(`PR #${cancelled.pr.number} (${cancelled.pr.url})`);
      const body: BodyOf<'system'> = {
        text: `Task ${cancelled.id} cancelled. Nothing was deleted: ${left.join(' and ')} remain${left.length === 1 ? 's' : ''}.`,
      };
      await this.deps.messages.post(tx, outbox, {
        threadId: cancelled.threadId,
        taskId: cancelled.id,
        kind: 'system',
        body,
      });
      outbox.stopTaskRuns(cancelled.id);
    });
  }
}
