import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { requireDispatcher } from '../tasks/guards.js';
import type { BodyOf } from './message-bodies.js';
import { transact } from '../transaction.js';

/** The dispatcher answers in the thread its run belongs to (SLK-02, DSP-07). */
export class Reply {
  constructor(private readonly deps: TaskDeps) {}

  async execute(
    identity: RunIdentity,
    input: { readonly text: string },
  ): Promise<{ messageId: string }> {
    requireDispatcher(identity);
    return transact(this.deps, async (tx, outbox) => {
      const body: BodyOf<'jarvis'> = { text: input.text };
      const message = await this.deps.messages.post(tx, outbox, {
        threadId: identity.threadId,
        taskId: null,
        kind: 'jarvis',
        body,
      });
      return { messageId: message.id };
    });
  }
}
