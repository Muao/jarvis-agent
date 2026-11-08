import type { ConnectionId } from '@jarvis/shared';
import type {
  ConnectionChecks,
  ConnectionOutcome,
} from '../../application/ports/connection-checks.js';
import { reasonOf, type Probe } from './probe.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** One probe per connection, each with a deadline; a probe that throws or is too slow becomes `failed` with the reason. */
export class ProbedConnectionChecks implements ConnectionChecks {
  private readonly timeoutMs: number;
  private readonly lastOutcomes = new Map<ConnectionId, ConnectionOutcome>();

  constructor(
    private readonly options: {
      readonly probes: Readonly<Record<ConnectionId, Probe>>;
      readonly billingEnvDetected: () => boolean;
      readonly timeoutMs?: number;
    },
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  billingEnvDetected(): boolean {
    return this.options.billingEnvDetected();
  }

  last(id: ConnectionId): ConnectionOutcome | null {
    return this.lastOutcomes.get(id) ?? null;
  }

  async check(id: ConnectionId): Promise<ConnectionOutcome> {
    const outcome = await this.probe(id);
    // Only an answer that confirms a valid login may clear `loginExpired`; a timeout or a failure keeps the entry.
    const previous = this.lastOutcomes.get(id);
    const keep =
      previous?.loginExpired === true && outcome.status !== 'ok' && outcome.status !== 'warning';
    if (!keep) this.lastOutcomes.set(id, outcome);
    return outcome;
  }

  private async probe(id: ConnectionId): Promise<ConnectionOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([this.options.probes[id](), deadline]);
    } catch (error) {
      return { status: 'failed', summary: `Check failed: ${reasonOf(error)}`, details: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}
