// Supervision timers: stalls, task timeouts, orphaned permissions (DSP-09, WRK-11) and queue resume (LIM-04).
import type { Application } from '../../application/index.js';
import type { Logger } from '../../application/ports/logger.js';
import { IntervalJob, type TimerApi } from './interval-job.js';

export const SUPERVISION_INTERVAL_MS = 30_000;
export const RESUME_INTERVAL_MS = 60_000;

export interface SupervisionDeps {
  readonly app: Pick<
    Application,
    'detectStalls' | 'postProgressUpdates' | 'enforceTaskTimeouts' | 'expireOrphanedPermissions'
  > & { readonly scheduler: Pick<Application['scheduler'], 'resumeQueued'> };
  /** Subscribes to config changes; returns the unsubscribe function. */
  readonly onConfigChange: (listener: () => void) => () => void;
  readonly logger: Logger;
  readonly timers?: TimerApi;
}

export interface Supervision {
  start(): void;
  stop(): Promise<void>;
}

/** Every 30 s the three supervisors, one after another; every 60 s and on a config change, the queue resume. */
export function createSupervision(deps: SupervisionDeps): Supervision {
  const { app, logger } = deps;
  const timers = deps.timers === undefined ? {} : { timers: deps.timers };

  const supervise = new IntervalJob({
    name: 'supervision',
    // Independent supervisors: one failing must not starve the others.
    run: async () => {
      const steps: [string, () => Promise<unknown>][] = [
        ['detect stalls', () => app.detectStalls.execute()],
        ['post progress updates', () => app.postProgressUpdates.execute()],
        ['enforce task timeouts', () => app.enforceTaskTimeouts.execute()],
        ['expire orphaned permissions', () => app.expireOrphanedPermissions.execute()],
      ];
      for (const [name, step] of steps) {
        try {
          await step();
        } catch (error) {
          logger.error(`${name} failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    intervalMs: SUPERVISION_INTERVAL_MS,
    logger,
    ...timers,
  });

  const resume = new IntervalJob({
    name: 'resume queued runs',
    run: () => app.scheduler.resumeQueued(),
    intervalMs: RESUME_INTERVAL_MS,
    logger,
    ...timers,
  });

  let unsubscribe: (() => void) | undefined;
  return {
    start() {
      supervise.start();
      resume.start();
      unsubscribe = deps.onConfigChange(() => resume.trigger());
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      await Promise.all([supervise.stop(), resume.stop()]);
    },
  };
}
