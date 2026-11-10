import { addOwnerEntry, formatLocalMinute, parseMemory, spliceMemory } from '../../domain/index.js';
import type { Clock } from '../ports/clock.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { RunIdentity } from '../run-identity.js';
import { requireDispatcher } from '../tasks/guards.js';

export interface RememberDeps {
  readonly profile: ProfileStore;
  readonly clock: Clock;
}

export interface RememberInput {
  readonly fact: string;
  /** `owner/name`; omitted means the fact applies everywhere. */
  readonly repo?: string | undefined;
}

/**
 * ADR-0013 / ADR-0021: dispatcher-only. Writes one owner entry under `## Learned` in `USER.md`,
 * so a fact survives into new threads instead of being re-guessed or re-asked. Returns its id.
 */
export class Remember {
  constructor(private readonly deps: RememberDeps) {}

  async execute(identity: RunIdentity, input: RememberInput): Promise<{ id: string }> {
    requireDispatcher(identity);
    const at = formatLocalMinute(this.deps.clock.now());
    return this.deps.profile.mutate((current) => {
      const { document, id } = addOwnerEntry(parseMemory(current), {
        fact: input.fact,
        repo: input.repo ?? null,
        at,
      });
      return { content: spliceMemory(current, document), result: { id } };
    });
  }
}
