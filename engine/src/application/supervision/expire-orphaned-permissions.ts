import type { ExpirePermission } from '../permissions/expire-permission.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { LiveRuns } from '../runs/live-runs.js';

/**
 * A permission request whose run is gone (it ended, or the engine restarted) can never be used:
 * nobody waits for the answer. It is denied right away instead of waiting for its deadline (SLK-05,
 * ST-04). Returns how many requests were expired.
 */
export class ExpireOrphanedPermissions {
  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork;
      readonly liveRuns: LiveRuns;
      readonly expire: ExpirePermission;
    },
  ) {}

  async execute(): Promise<number> {
    const pending = await this.deps.uow.run((tx) => tx.permissions.listPending());
    const orphaned = pending.filter(
      (request) => this.deps.liveRuns.get(request.runId) === undefined,
    );
    for (const request of orphaned) {
      await this.deps.expire.execute(request.id, { orphaned: true });
    }
    return orphaned.length;
  }
}
