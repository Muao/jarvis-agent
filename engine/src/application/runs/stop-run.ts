import { DomainError } from '../../domain/index.js';
import { NotFoundError } from '../errors.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';
import type { LiveRuns } from './live-runs.js';

/** ADM-06: the owner stops one running process. The task is not changed; the journal records who did it. */
export class StopRun {
  constructor(private readonly deps: TaskDeps & { readonly liveRuns: LiveRuns }) {}

  async execute(runId: string): Promise<void> {
    const live = this.deps.liveRuns.get(runId);
    const handle = live?.handle ?? null;
    if (live === undefined || handle === null) {
      const known = await this.deps.uow.run((tx) => tx.runs.get(runId));
      if (known === null) throw new NotFoundError('run', runId);
      throw new DomainError('run_not_running', `Run ${runId} is not running`);
    }
    if (live.taskId !== null) {
      const { taskId } = live;
      await transact(this.deps, (tx) =>
        this.deps.writer.note(tx, taskId, 'run_stopped', 'owner', { runId }),
      );
    }
    await handle.stop();
  }
}
