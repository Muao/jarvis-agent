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

  async check(id: ConnectionId): Promise<ConnectionOutcome> {
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
