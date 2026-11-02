import type { RunIdentity } from '../run-identity.js';
import type { RunRegistry } from './run-registry.js';

/** Presentation calls this with the bearer token of an internal agent request. */
export class ResolveRunIdentity {
  constructor(private readonly registry: RunRegistry) {}

  /** Throws `ForbiddenError` for a token that belongs to no live run. */
  execute(token: string): RunIdentity {
    return this.registry.resolve(token);
  }
}
