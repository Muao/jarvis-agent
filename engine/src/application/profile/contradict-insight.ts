import type { RunIdentity } from '../run-identity.js';
import { countOnce, type CountInsightDeps } from './count-insight.js';

/**
 * ADR-0021: the worker's `contradict_insight` — ✗ +1 for this task, once per entry; the reason goes
 * to the journal. On an owner entry the file does not change and the thread is told instead.
 */
export class ContradictInsight {
  constructor(private readonly deps: CountInsightDeps) {}

  async execute(
    identity: RunIdentity,
    input: { readonly id: string; readonly reason: string },
  ): Promise<{ ok: true; contradicted: number; counted: boolean }> {
    const { count, counted } = await countOnce(this.deps, identity, input, 'contradicted');
    return { ok: true, contradicted: count, counted };
  }
}
