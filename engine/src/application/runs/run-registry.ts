import { ForbiddenError } from '../errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { RunIdentity } from '../run-identity.js';

/** Run token -> identity, for live runs only (ADR-0004). Nothing is persisted: a restart ends every run. */
export class RunRegistry {
  private readonly identities = new Map<string, RunIdentity>();

  constructor(private readonly ids: IdGenerator) {}

  /** A fresh random token for the run. */
  issue(identity: RunIdentity): string {
    const token = this.ids.token();
    this.identities.set(token, identity);
    return token;
  }

  revoke(token: string): void {
    this.identities.delete(token);
  }

  /** The identity behind a token; unknown and finished runs are forbidden. */
  resolve(token: string): RunIdentity {
    const identity = this.identities.get(token);
    if (identity === undefined) throw new ForbiddenError('unknown or finished run');
    return identity;
  }
}
