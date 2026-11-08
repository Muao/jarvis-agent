// Outbound liveness (ADR-0018): the one signal a dead process cannot send itself is a ping that stops arriving.
import type { GetHealth } from '../../application/queries/get-health.js';
import type { Heartbeat } from '../../application/ports/heartbeat.js';
import type { Logger } from '../../application/ports/logger.js';
import { IntervalJob, type TimerApi } from './interval-job.js';

export const HEARTBEAT_INTERVAL_MS = 60_000;

export interface HeartbeatTimerDeps {
  readonly health: Pick<GetHealth, 'execute'>;
  readonly heartbeat: Heartbeat;
  readonly logger: Logger;
  readonly timers?: TimerApi;
}

export interface HeartbeatTimer {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Every minute: `degraded` still pings success (an expiring login is not a dead engine), `failed` pings `/fail`.
 * A failed ping is logged at `warn` without the URL and never thrown.
 */
export function createHeartbeatTimer(deps: HeartbeatTimerDeps): HeartbeatTimer {
  const job = new IntervalJob({
    name: 'heartbeat',
    run: async () => {
      try {
        const health = await deps.health.execute();
        await deps.heartbeat.beat(health.status === 'failed' ? 'fail' : 'ok');
      } catch (error) {
        deps.logger.warn('heartbeat failed', {
          event: 'heartbeat.failed',
          reason: error instanceof Error ? error.message : 'unknown error',
        });
      }
    },
    intervalMs: HEARTBEAT_INTERVAL_MS,
    logger: deps.logger,
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
  });
  return { start: () => job.start(), stop: () => job.stop() };
}
