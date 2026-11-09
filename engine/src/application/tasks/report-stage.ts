import { transact } from '../transaction.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';

export interface ReportStageInput {
  readonly stage: 'Implementing' | 'Verifying' | 'Reviewing' | 'Done';
  readonly note?: string;
}

/**
 * The worker moves between Implementing, Verifying and Reviewing; repeating the current stage only
 * adds a note. A `ui_check` task also closes itself with `Done` (ADR-0018): it never opens a pull
 * request, so the watcher's `PR Open -> Done` never reaches it and this is its only way to finish.
 * What is legal is decided by the task kind's transition table, not here — a `build` task asking
 * for `Done` is refused with `illegal_transition`.
 */
export class ReportStage {
  constructor(private readonly deps: TaskDeps) {}

  execute(identity: RunIdentity, input: ReportStageInput): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadWorkerTask(tx, identity);
      if (task.stage === input.stage) {
        await this.deps.writer.note(tx, task.id, 'stage_note', 'agent', {
          stage: input.stage,
          note: input.note ?? null,
        });
        // A note on an unchanged stage is the worker's chosen moment to narrate progress to the
        // owner (status updates during a long stage, not just at stage transitions).
        if (input.note !== undefined) {
          await this.deps.messages.post(tx, outbox, {
            threadId: task.threadId,
            taskId: task.id,
            kind: 'jarvis',
            body: { text: input.note },
          });
        }
        return;
      }
      await this.deps.writer.move(tx, outbox, task, input.stage, { cause: 'stage_reported' });
      if (input.note !== undefined) {
        await this.deps.writer.note(tx, task.id, 'stage_note', 'agent', {
          stage: input.stage,
          note: input.note,
        });
      }
    });
  }
}
