import type { RunIdentity } from '../run-identity.js';
import { countOnce, type CountInsightDeps } from './count-insight.js';

/** ADR-0021: the worker's `confirm_insight` — ✓ +1 for this task, once per entry. */
export class ConfirmInsight {
  constructor(private readonly deps: CountInsightDeps) {}

  async execute(
    identity: RunIdentity,
    input: { readonly id: string },
  ): Promise<{ ok: true; confirmed: number; counted: boolean }> {
    const { count, counted } = await countOnce(this.deps, identity, input, 'confirmed');
    return { ok: true, confirmed: count, counted };
  }
}
