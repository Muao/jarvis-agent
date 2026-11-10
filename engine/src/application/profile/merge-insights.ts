import { mergeEntries, parseMemory, spliceMemory } from '../../domain/index.js';
import type { Logger } from '../ports/logger.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { RunIdentity } from '../run-identity.js';
import { requireDispatcher } from '../tasks/guards.js';
import { guardMemory } from './memory-support.js';

/**
 * ADR-0021: dispatcher-only. Replaces several entries of one scope with one that carries `fact`
 * and their summed counters. The file is copied to the backups directory first. Returns the new id.
 */
export class MergeInsights {
  constructor(private readonly deps: { readonly profile: ProfileStore; readonly logger: Logger }) {}

  async execute(
    identity: RunIdentity,
    input: { readonly ids: readonly string[]; readonly fact: string },
  ): Promise<{ id: string }> {
    requireDispatcher(identity);
    const merged = await guardMemory(() =>
      this.deps.profile.mutate(
        (current) => {
          const { document, id, removed } = mergeEntries(parseMemory(current), input);
          return {
            content: spliceMemory(current, document),
            result: { id, removed: removed.map((e) => ({ id: e.id, fact: e.fact })) },
          };
        },
        { backup: true },
      ),
    );
    // No task to journal this against: the log is the record of a merge (ADR-0021).
    this.deps.logger.info(
      `memory ${merged.removed.map((e) => e.id).join(', ')} merged into ${merged.id}`,
      {
        event: 'memory.merged',
        entryId: merged.id,
        from: merged.removed,
        fact: input.fact.trim(),
      },
    );
    return { id: merged.id };
  }
}
