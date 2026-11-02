import { RETRYABLE_STAGES } from '@jarvis/shared';
import { DomainError } from '../../domain/index.js';
import { transact } from '../transaction.js';
import type { TaskDeps } from './deps.js';
import { loadTask } from './guards.js';

/**
 * `POST /api/tasks/:id/retry`. A Failed task goes back to the stage it failed in with fresh
 * attempts (owner_retry); a working task just gets a new run (resume the session).
 * `RETRYABLE_STAGES` is shared, so the web enables `Retry stage` for exactly these stages.
 */
export class RetryStage {
  constructor(private readonly deps: TaskDeps) {}

  execute(taskId: string): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadTask(tx, taskId);
      if (!RETRYABLE_STAGES.includes(task.stage)) {
        throw new DomainError(
          'illegal_transition',
          `Task ${task.id} (${task.stage}) cannot be retried`,
        );
      }
      if (task.stage === 'Failed' && task.resumeStage !== null) {
        await this.deps.writer.move(tx, outbox, task, task.resumeStage, { cause: 'owner_retry' });
      } else {
        await this.deps.writer.note(tx, task.id, 'retry_requested', 'owner', { stage: task.stage });
      }
      outbox.requestWorkerRun(task.id, 'retry');
    });
  }
}
