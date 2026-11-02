import type { ApproveResult } from '@jarvis/shared';
import { elapsedMs } from '../../domain/index.js';
import { NotFoundError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { toApproveResult } from './approve-result.js';
import type { ExpirePermission } from './expire-permission.js';
import type { PermissionWaiters } from './permission-waiters.js';

/** Fires a moment after the deadline so the clock the domain checks is certainly past it. */
const EXPIRY_GRACE_MS = 1000;

/**
 * The long-poll behind the `approve` tool: resolves with the CLI's allow/deny answer as soon as
 * the owner decides, or with a deny when the request expires (SLK-05).
 */
export class AwaitPermission {
  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork;
      readonly clock: Clock;
      readonly logger: Logger;
      readonly waiters: PermissionWaiters;
      readonly expire: ExpirePermission;
    },
  ) {}

  async execute(permissionId: string): Promise<ApproveResult> {
    const { uow, clock, logger, waiters, expire } = this.deps;
    const load = async () => {
      const request = await uow.run((tx) => tx.permissions.get(permissionId));
      if (request === null) throw new NotFoundError('permission', permissionId);
      return request;
    };

    let request = await load();
    if (request.status === 'pending') {
      const untilExpiry = Math.max(0, elapsedMs(clock.now(), request.expiresAt));
      await waiters.wait(permissionId, untilExpiry + EXPIRY_GRACE_MS, () =>
        expire.execute(permissionId).catch((error: unknown) => {
          logger.error('permission expiry failed', {
            permissionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
      request = await load();
    }
    return toApproveResult(request);
  }
}
