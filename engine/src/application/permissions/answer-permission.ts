import { decidePermission, type PermissionDecision } from '../../domain/index.js';
import { NotFoundError } from '../errors.js';
import type { RunEventLog } from '../runs/run-event-log.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';
import type { PermissionWaiters } from './permission-waiters.js';
import { recordPermissionEvent } from './record-permission-event.js';

/** SLK-05: the owner allows or denies once (`POST /api/permissions/:id`); the waiting run is woken. */
export class AnswerPermission {
  constructor(
    private readonly deps: TaskDeps & {
      readonly waiters: PermissionWaiters;
      readonly eventLog: RunEventLog;
    },
  ) {}

  async execute(permissionId: string, decision: PermissionDecision): Promise<void> {
    const decided = await transact(this.deps, async (tx, outbox) => {
      const request = await tx.permissions.get(permissionId);
      if (request === null) throw new NotFoundError('permission', permissionId);
      const next = decidePermission(request, decision, this.deps.clock.now());
      await tx.permissions.save(next);

      const card = await tx.messages.permissionCardOf(permissionId);
      const task = next.taskId === null ? null : await tx.tasks.get(next.taskId);
      if (card !== null) await this.deps.messages.answer(tx, outbox, card, { decision }, task);
      if (task !== null) {
        await this.deps.writer.note(tx, task.id, 'permission_answered', 'owner', {
          permissionId,
          tool: next.tool,
          decision,
        });
        outbox.taskChanged(task);
      }
      return next;
    });
    this.deps.waiters.settle(permissionId);
    await recordPermissionEvent({ ...this.deps, logger: this.deps.notifiers.logger }, decided);
  }
}
