import { isTerminal } from '../../domain/index.js';
import { ForbiddenError, NotFoundError } from '../errors.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';

export type SessionMessageDelivery = 'queued' | 'delivered';

/**
 * ADM-06 "Send message" in the console. The text becomes an owner message of the session's thread:
 * for a worker session it is written to the live process or waits for the next run (DSP-04); for a
 * dispatcher session it waits for the next dispatcher turn.
 */
export class SendToSession {
  constructor(private readonly deps: TaskDeps) {}

  async execute(sessionId: string, text: string): Promise<SessionMessageDelivery> {
    const messageId = await transact(this.deps, async (tx, outbox) => {
      const session = await tx.sessions.get(sessionId);
      if (session === null) throw new NotFoundError('session', sessionId);
      if (session.taskId === null) {
        const message = await this.deps.messages.postOwner(tx, outbox, {
          threadId: session.threadId,
          taskId: null,
          text,
        });
        outbox.requestDispatcherTurn(session.threadId);
        return message.id;
      }
      const task = await tx.tasks.get(session.taskId);
      if (task === null) throw new NotFoundError('task', session.taskId);
      if (isTerminal(task.stage)) {
        throw new ForbiddenError(`task ${task.id} is ${task.stage}; it takes no more input`);
      }
      const message = await this.deps.messages.postOwner(tx, outbox, {
        threadId: task.threadId,
        taskId: task.id,
        text,
      });
      await this.deps.writer.note(tx, task.id, 'owner_input', 'owner', {
        messageId: message.id,
        via: 'console',
      });
      await this.deps.writer.reopenForOwnerInput(tx, outbox, task, message);
      outbox.deliverToWorker(task.id);
      return message.id;
    });
    const sent = await this.deps.uow.run((tx) => tx.messages.get(messageId));
    return sent?.body.delivery === 'delivered' ? 'delivered' : 'queued';
  }
}
