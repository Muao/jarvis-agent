import { transact } from '../transaction.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';

export interface ReportStageInput {
  readonly stage: 'Implementing' | 'Verifying' | 'Reviewing';
  readonly note?: string;
}

/** The worker moves between Implementing, Verifying and Reviewing; repeating the current stage only adds a note. */
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
