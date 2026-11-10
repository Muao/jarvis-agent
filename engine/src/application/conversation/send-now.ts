import { NotFoundError, InvalidInputError } from '../errors.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';

/**
 * "Send now": an owner message waits for its task's worker, which is not running (queued for a
 * slot, or on hold). The owner can hand it to the thread's dispatcher instead, which answers at
 * once and can act on the task (hold, resume, switch model, forward, cancel). The message leaves
 * the worker's input — the dispatcher forwards it with `send_to_task` if the worker should see it.
 */
export class SendNow {
  constructor(private readonly deps: TaskDeps) {}

  execute(messageId: string): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const message = await tx.messages.get(messageId);
      if (message === null) throw new NotFoundError('message', messageId);
      const { body } = message;
      if (
        message.kind !== 'owner' ||
        (body.source !== undefined && body.source !== 'owner') ||
        body.delivery !== 'queued' ||
        message.taskId === null
      ) {
        throw new InvalidInputError(
          "only an owner message that still waits for its task's worker can be sent now",
        );
      }
      await this.deps.messages.replace(tx, outbox, { ...message, taskId: null });
      outbox.requestDispatcherTurn(message.threadId);
    });
  }
}
