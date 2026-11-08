import type { ProfileStore } from '../ports/profile-store.js';
import type { RunIdentity } from '../run-identity.js';
import { requireDispatcher } from '../tasks/guards.js';

export interface RememberDeps {
  readonly profile: ProfileStore;
}

export interface RememberInput {
  readonly fact: string;
}

/**
 * ADR-0020: dispatcher-only. Appends one learned fact as a bullet under `## Learned` in
 * `USER.md`, so it survives into new threads instead of being re-guessed or re-asked.
 */
export class Remember {
  constructor(private readonly deps: RememberDeps) {}

  async execute(identity: RunIdentity, input: RememberInput): Promise<void> {
    requireDispatcher(identity);
    await this.deps.profile.appendLearned(input.fact);
  }
}
