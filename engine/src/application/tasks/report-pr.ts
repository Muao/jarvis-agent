import { attachPullRequest } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import { newWatch } from '../code-host/new-watch.js';
import { transact } from '../transaction.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';

export interface ReportPrInput {
  readonly number: number;
  readonly url: string;
}

/**
 * CI-01: the worker opened a draft PR (or pushed a fix to it). The task goes to PR Open, the watcher
 * gets a record for the PR, and the first time the owner gets a result card.
 */
export class ReportPr {
  constructor(private readonly deps: TaskDeps) {}

  execute(identity: RunIdentity, input: ReportPrInput): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadWorkerTask(tx, identity);
      const firstPr = task.pr === null;
      const withPr = attachPullRequest(task, input, this.deps.clock.now());
      await this.deps.writer.move(tx, outbox, withPr, 'PR Open', { cause: 'pr_reported' });
      await this.deps.writer.note(tx, task.id, 'pr_reported', 'agent', { ...input });

      // The watcher keeps what it already processed while the PR stays the same (CI-09).
      const watch = await tx.watches.get(task.id);
      await tx.watches.save(
        watch?.prNumber === input.number ? watch : newWatch(task.id, input.number),
      );

      if (firstPr) {
        const body: BodyOf<'result'> = {
          taskId: task.id,
          summary: `Draft PR #${input.number} opened`,
          prUrl: input.url,
        };
        await this.deps.messages.post(tx, outbox, {
          threadId: task.threadId,
          taskId: task.id,
          kind: 'result',
          body,
        });
      }
    });
  }
}
