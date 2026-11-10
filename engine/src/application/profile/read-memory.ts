import { numberLegacy, parseMemory, renderMemory, spliceMemory } from '../../domain/index.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { RunIdentity } from '../run-identity.js';
import { requireDispatcher } from '../tasks/guards.js';

/** ADR-0021: dispatcher-only. The whole `## Learned` section, for the `memory-review` skill. */
export class ReadMemory {
  constructor(private readonly deps: { readonly profile: ProfileStore }) {}

  async execute(identity: RunIdentity): Promise<{ text: string }> {
    requireDispatcher(identity);
    // A hand-written line gets its id here, so the dispatcher can name every entry it is shown.
    const text = await this.deps.profile.mutate((current) => {
      const document = numberLegacy(parseMemory(current));
      return {
        content: document.present ? spliceMemory(current, document) : current,
        result: renderMemory(document),
      };
    });
    return { text };
  }
}
