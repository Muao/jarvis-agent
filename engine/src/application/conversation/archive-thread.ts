import { archiveThread, unarchiveThread } from '../../domain/index.js';
import { NotFoundError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import { transact, type TransactionDeps } from '../transaction.js';

/**
 * The owner archives a thread or brings it back. Archiving only hides the thread from the list:
 * its task, runs and cards go on as they are, so any thread can be archived at any time.
 */
export class ArchiveThread {
  constructor(private readonly deps: TransactionDeps & { readonly clock: Clock }) {}

  execute(input: { readonly threadId: string; readonly archived: boolean }): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const thread = await tx.threads.get(input.threadId);
      if (thread === null) throw new NotFoundError('thread', input.threadId);
      const changed = input.archived
        ? archiveThread(thread, this.deps.clock.now())
        : unarchiveThread(thread);
      if (changed === thread) return;
      await tx.threads.save(changed);
      outbox.threadChanged(thread.id);
    });
  }
}
