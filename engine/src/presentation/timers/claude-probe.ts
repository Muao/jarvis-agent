// Keeps the claude probe fresh: on a headless server nobody opens the Connections screen.
import type { ConnectionChecks } from '../../application/ports/connection-checks.js';
import type { Logger } from '../../application/ports/logger.js';
import { IntervalJob, type TimerApi } from './interval-job.js';

export const CLAUDE_PROBE_INTERVAL_MS = 300_000;

export interface ClaudeProbeDeps {
  readonly checks: Pick<ConnectionChecks, 'check'>;
  readonly logger: Logger;
  readonly timers?: TimerApi;
}

export interface ClaudeProbeRefresh {
  start(): void;
  stop(): Promise<void>;
}

/** Every 5 minutes one `claude --version` and `claude auth status`: no model run, so no cost. */
export function createClaudeProbeRefresh(deps: ClaudeProbeDeps): ClaudeProbeRefresh {
  const job = new IntervalJob({
    name: 'claude probe',
    run: async () => {
      await deps.checks.check('claude');
    },
    intervalMs: CLAUDE_PROBE_INTERVAL_MS,
    // The first answer should not wait five minutes: /api/health reads the cache.
    immediate: true,
    logger: deps.logger,
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
  });
  return { start: () => job.start(), stop: () => job.stop() };
}
