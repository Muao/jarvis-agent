import { forgetEntry, parseMemory, spliceMemory } from '../../domain/index.js';
import type { Logger } from '../ports/logger.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { RunIdentity } from '../run-identity.js';
import { requireDispatcher } from '../tasks/guards.js';
import { guardMemory } from './memory-support.js';

/**
 * ADR-0021: dispatcher-only. Removes one entry, on the owner's request. The file is copied to the
 * backups directory first. Nothing else — no worker tool, no timer — ever removes an entry.
 */
export class Forget {
  constructor(private readonly deps: { readonly profile: ProfileStore; readonly logger: Logger }) {}

  async execute(identity: RunIdentity, input: { readonly id: string }): Promise<void> {
    requireDispatcher(identity);
    const removed = await guardMemory(() =>
      this.deps.profile.mutate(
        (current) => {
          const { document, removed } = forgetEntry(parseMemory(current), input.id);
          return { content: spliceMemory(current, document), result: removed };
        },
        { backup: true },
      ),
    );
    // No task to journal this against: the log is the record of a removal (ADR-0021).
    this.deps.logger.info(`memory ${input.id} forgotten`, {
      event: 'memory.forgotten',
      entryId: input.id,
      fact: removed.fact,
    });
  }
}
