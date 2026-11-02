import { ConnectionIdSchema, type ConnectionDto, type ConnectionsDto } from '@jarvis/shared';
import type { Clock } from '../ports/clock.js';
import type { ConnectionChecks } from '../ports/connection-checks.js';

/**
 * `GET /api/connections`: probes every connection (CTX-01…CTX-05, ADM-08). The probes run side by
 * side and never reject, so one slow or broken service cannot hide the others.
 */
export class GetConnections {
  constructor(
    private readonly deps: { readonly checks: ConnectionChecks; readonly clock: Clock },
  ) {}

  async execute(): Promise<ConnectionsDto> {
    const { checks, clock } = this.deps;
    let claudeSubscription: boolean | null = null;
    const connections = await Promise.all(
      ConnectionIdSchema.options.map(async (id): Promise<ConnectionDto> => {
        const outcome = await checks.check(id);
        if (id === 'claude') claudeSubscription = outcome.subscription ?? null;
        return {
          id,
          status: outcome.status,
          summary: outcome.summary,
          details: [...outcome.details],
          // A disabled connection (Slack in iteration 1) was never probed.
          checkedAt: outcome.status === 'disabled' ? null : clock.now(),
        };
      }),
    );
    return { billingEnvDetected: checks.billingEnvDetected(), claudeSubscription, connections };
  }
}
