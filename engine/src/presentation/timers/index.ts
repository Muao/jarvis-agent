// Background timers of the engine (T13): PR watcher, supervision and the claude probe refresh and the optional heartbeat, started after the API is listening.
import type { Application } from '../../application/index.js';
import type { ConfigProvider } from '../../application/ports/config-provider.js';
import type { ConnectionChecks } from '../../application/ports/connection-checks.js';
import type { Heartbeat } from '../../application/ports/heartbeat.js';
import type { Logger } from '../../application/ports/logger.js';
import { createPrWatcher } from '../watcher/watcher.js';
import { createClaudeProbeRefresh } from './claude-probe.js';
import { createHeartbeatTimer } from './heartbeat.js';
import type { TimerApi } from './interval-job.js';
import { createSupervision } from './supervision.js';

export interface TimerDeps {
  readonly config: ConfigProvider;
  readonly onConfigChange: (listener: () => void) => () => void;
  readonly logger: Logger;
  /** Only `check('claude')` is called, to keep `/api/health` and the run gate fed. */
  readonly checks: Pick<ConnectionChecks, 'check'>;
  /** Present only when `HEARTBEAT_URL` is set; without it the heartbeat timer does not start. */
  readonly heartbeat?: Heartbeat;
  readonly timers?: TimerApi;
}

export interface RunningTimers {
  /** Stops all timers and waits for the runs in flight. */
  stop(): Promise<void>;
}

export function startTimers(app: Application, deps: TimerDeps): RunningTimers {
  const common = {
    logger: deps.logger,
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
  };
  const watcher = createPrWatcher({
    ...common,
    pollPullRequests: app.pollPullRequests,
    config: deps.config,
  });
  const supervision = createSupervision({ ...common, app, onConfigChange: deps.onConfigChange });
  const claudeProbe = createClaudeProbeRefresh({ ...common, checks: deps.checks });
  const heartbeat =
    deps.heartbeat === undefined
      ? undefined
      : createHeartbeatTimer({ ...common, health: app.getHealth, heartbeat: deps.heartbeat });
  watcher.start();
  supervision.start();
  claudeProbe.start();
  heartbeat?.start();
  return {
    async stop() {
      await Promise.all([
        watcher.stop(),
        supervision.stop(),
        claudeProbe.stop(),
        heartbeat?.stop(),
      ]);
    },
  };
}
