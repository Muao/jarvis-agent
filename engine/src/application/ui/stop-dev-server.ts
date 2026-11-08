import type { DevServerManager } from '../ports/dev-server.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';

export interface StopDevServerDeps extends TaskDeps {
  readonly devServers: DevServerManager;
}

/**
 * ADR-0014: the worker's `stop_dev_server`. Courtesy only — the lease kills the server anyway —
 * so a task without a lease is a no-op rather than an error.
 */
export class StopDevServer {
  constructor(private readonly deps: StopDevServerDeps) {}

  async execute(identity: RunIdentity): Promise<{ readonly stopped: boolean }> {
    const task = await transact(this.deps, (tx) => loadWorkerTask(tx, identity));
    const held = this.deps.devServers.current()?.taskId === task.id;
    await this.deps.devServers.stop(task.id);
    return { stopped: held };
  }
}
