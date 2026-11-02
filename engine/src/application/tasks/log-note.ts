import { transact } from '../transaction.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';

/** The worker's `log_note` tool: a free-text line in the task journal (ST-03); it changes nothing else. */
export class LogNote {
  constructor(private readonly deps: TaskDeps) {}

  execute(identity: RunIdentity, input: { readonly text: string }): Promise<void> {
    return transact(this.deps, async (tx) => {
      const task = await loadWorkerTask(tx, identity);
      await this.deps.writer.note(tx, task.id, 'agent_note', 'agent', { text: input.text });
    });
  }
}
