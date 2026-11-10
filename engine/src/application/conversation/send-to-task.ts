import { isTerminal } from '../../domain/index.js';
import { ForbiddenError } from '../errors.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadTask, requireDispatcher } from '../tasks/guards.js';
import { transact } from '../transaction.js';

/** DSP-04: the dispatcher forwards the owner's words to a task's worker; they wait as queued input. */
export class SendToTask {
  constructor(private readonly deps: TaskDeps) {}

  async execute(
    identity: RunIdentity,
    input: { readonly taskId: string; readonly message: string },
  ): Promise<void> {
    requireDispatcher(identity);
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadTask(tx, input.taskId);
      if (isTerminal(task.stage)) {
        throw new ForbiddenError(`task ${task.id} is ${task.stage}; it takes no more input`);
      }
      const message = await this.deps.messages.postOwner(tx, outbox, {
        threadId: task.threadId,
        taskId: task.id,
        text: input.message,
      });
      await this.deps.writer.note(tx, task.id, 'owner_input', 'agent', { messageId: message.id });
      await this.deps.writer.reopenForOwnerInput(tx, outbox, task, message);
      outbox.deliverToWorker(task.id);
    });
  }
}
