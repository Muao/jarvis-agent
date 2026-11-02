// PR watcher (CI-02, CI-09, NFR-03): polls the code host on `watch.pollSeconds`. No model calls: only the use case.
import type { Application } from '../../application/index.js';
import type { ConfigProvider } from '../../application/ports/config-provider.js';
import type { Logger } from '../../application/ports/logger.js';
import { IntervalJob, type TimerApi } from '../timers/interval-job.js';

export interface PrWatcherDeps {
  readonly pollPullRequests: Pick<Application['pollPullRequests'], 'execute'>;
  readonly config: ConfigProvider;
  readonly logger: Logger;
  readonly timers?: TimerApi;
}

/** One poll right away (catches up after sleep or a restart), then one per `watch.pollSeconds`, re-read each tick. */
export function createPrWatcher(deps: PrWatcherDeps): IntervalJob {
  return new IntervalJob({
    name: 'pr watcher',
    run: () => deps.pollPullRequests.execute(),
    intervalMs: () => deps.config.current().watch.pollSeconds * 1000,
    logger: deps.logger,
    immediate: true,
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
  });
}
