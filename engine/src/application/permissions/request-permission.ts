import { requestPermission } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { RunIdentity } from '../run-identity.js';
import type { RunEventLog } from '../runs/run-event-log.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';
import { recordPermissionEvent } from './record-permission-event.js';

export interface PermissionRequestInput {
  readonly tool_name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** SLK-05: a run asks for a tool it may not use on its own; the owner sees a card in the task's thread. */
export class RequestPermission {
  constructor(
    private readonly deps: TaskDeps & {
      readonly ids: IdGenerator;
      readonly config: ConfigProvider;
      readonly eventLog: RunEventLog;
    },
  ) {}

  /** Returns the request id to wait on with `AwaitPermission`. */
  async execute(identity: RunIdentity, input: PermissionRequestInput): Promise<string> {
    const request = await transact(this.deps, async (tx, outbox) => {
      // A run left over from a cancelled or failed task gets nothing to decide.
      const task = identity.role === 'worker' ? await loadWorkerTask(tx, identity) : null;
      const requester = task === null ? 'dispatcher' : `worker ${task.id}`;
      const created = requestPermission({
        id: this.deps.ids.permissionId(),
        runId: identity.runId,
        threadId: identity.threadId,
        taskId: task?.id ?? null,
        tool: input.tool_name,
        description: `${requester} asks to use ${input.tool_name}`,
        input: input.input,
        at: this.deps.clock.now(),
        timeoutMinutes: this.deps.config.current().limits.permissionTimeoutMinutes,
      });
      await tx.permissions.save(created);
      const body: BodyOf<'permission'> = {
        permissionId: created.id,
        requester,
        toolName: created.tool,
        description: created.description,
        input: { ...created.input },
      };
      await this.deps.messages.post(tx, outbox, {
        threadId: created.threadId,
        taskId: created.taskId,
        kind: 'permission',
        body,
      });
      if (task !== null) {
        await this.deps.writer.note(tx, task.id, 'permission_requested', 'agent', {
          permissionId: created.id,
          tool: created.tool,
        });
        outbox.taskChanged(task);
      }
      return created;
    });
    this.deps.notifiers.logger.info(`permission requested for ${request.tool}`, {
      event: 'permission.requested',
      runId: request.runId,
      threadId: request.threadId,
      ...(request.taskId === null ? {} : { taskId: request.taskId }),
    });
    await recordPermissionEvent({ ...this.deps, logger: this.deps.notifiers.logger }, request);
    return request.id;
  }
}
