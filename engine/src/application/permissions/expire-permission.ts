import { timeoutPermission } from '../../domain/index.js';
import { NotFoundError } from '../errors.js';
import type { RunEventLog } from '../runs/run-event-log.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';
import type { PermissionWaiters } from './permission-waiters.js';
import { recordPermissionEvent } from './record-permission-event.js';

/**
 * SLK-05: a request nobody answered in time is denied and the task journal says so. Called by the
 * waiting `AwaitPermission` and by the expiry sweep (T13); a request that is already decided, or
 * not due yet, is left alone.
 */
export class ExpirePermission {
  constructor(
    private readonly deps: TaskDeps & {
      readonly waiters: PermissionWaiters;
      readonly eventLog: RunEventLog;
    },
  ) {}

  /**
   * `orphaned`: the run that asked is gone, so nobody can use the answer; the request ends now
   * instead of at its deadline.
   */
  async execute(
    permissionId: string,
    options: { readonly orphaned?: boolean } = {},
  ): Promise<void> {
    const expired = await transact(this.deps, async (tx, outbox) => {
      const request = await tx.permissions.get(permissionId);
      if (request === null) throw new NotFoundError('permission', permissionId);
      if (request.status !== 'pending') return null;
      const now = this.deps.clock.now();
      const orphaned = options.orphaned === true;
      if (!orphaned && Date.parse(now) < Date.parse(request.expiresAt)) return null;

      const timedOut = timeoutPermission(orphaned ? { ...request, expiresAt: now } : request, now);
      const next = { ...timedOut, expiresAt: request.expiresAt };
      await tx.permissions.save(next);
      const card = await tx.messages.permissionCardOf(permissionId);
      const task = next.taskId === null ? null : await tx.tasks.get(next.taskId);
      if (card !== null && task?.stage !== 'Cancelled') {
        await this.deps.messages.answer(tx, outbox, card, { decision: 'deny' }, task);
      }
      if (task !== null) {
        await this.deps.writer.note(tx, task.id, 'permission_timeout', 'system', {
          permissionId,
          tool: next.tool,
          ...(orphaned ? { reason: 'run_ended' } : {}),
        });
        outbox.taskChanged(task);
      }
      return next;
    });
    if (expired === null) return;
    this.deps.waiters.settle(permissionId);
    this.deps.notifiers.logger.info(`permission for ${expired.tool} ${expired.status}`, {
      event: 'permission.answered',
      runId: expired.runId,
      threadId: expired.threadId,
      ...(expired.taskId === null ? {} : { taskId: expired.taskId }),
    });
    await recordPermissionEvent({ ...this.deps, logger: this.deps.notifiers.logger }, expired);
  }
}
