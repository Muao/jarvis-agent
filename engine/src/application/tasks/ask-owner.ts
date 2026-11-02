import type { BodyOf } from '../conversation/message-bodies.js';
import { transact } from '../transaction.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';

export interface AskOwnerInput {
  readonly question: string;
  readonly options?: readonly string[];
}

/** WRK-05: the worker asks one concrete question; the task is Blocked until the owner answers. */
export class AskOwner {
  constructor(private readonly deps: TaskDeps) {}

  execute(identity: RunIdentity, input: AskOwnerInput): Promise<{ cardId: string }> {
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadWorkerTask(tx, identity);
      const blocked = await this.deps.writer.move(tx, outbox, task, 'Blocked', {
        cause: 'ask_owner',
        reason: input.question,
      });
      const body: BodyOf<'question'> = {
        taskId: blocked.id,
        question: input.question,
        options: [...(input.options ?? [])],
      };
      const card = await this.deps.messages.post(tx, outbox, {
        threadId: blocked.threadId,
        taskId: blocked.id,
        kind: 'question',
        body,
      });
      return { cardId: card.id };
    });
  }
}
