import { transact } from '../transaction.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';

/**
 * The worker's `post_update` tool: a visible progress line in the owner's chat, unlike `log_note`
 * (journal-only). Works in any stage, including `Context`/`Spec Review` where `report_stage` cannot be
 * called at all — this is the only way to narrate progress during those two stages.
 */
export class PostUpdate {
  constructor(private readonly deps: TaskDeps) {}

  execute(identity: RunIdentity, input: { readonly text: string }): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadWorkerTask(tx, identity);
      await this.deps.writer.note(tx, task.id, 'agent_note', 'agent', { text: input.text });
      await this.deps.messages.post(tx, outbox, {
        threadId: task.threadId,
        taskId: task.id,
        kind: 'jarvis',
        body: { text: input.text },
      });
    });
  }
}
