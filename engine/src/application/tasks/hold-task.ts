import type { TaskModel } from '@jarvis/shared';
import { holdTask, resumeTask, setTaskModel, type Task } from '../../domain/index.js';
import type { RunIdentity } from '../run-identity.js';
import { transact } from '../transaction.js';
import type { TaskDeps } from './deps.js';
import { loadTask, requireDispatcher } from './guards.js';

interface Change {
  readonly task: Task;
  readonly event: string;
  readonly data: Record<string, unknown>;
  /** What the thread is told. */
  readonly text: string;
  /** Start whatever queued work fits now (the task may start). */
  readonly resume?: boolean;
}

/**
 * Owner controls over a task that are not a stage: hold it, resume it, switch its model. Called by
 * the owner (HTTP, no identity) or by the dispatcher on the owner's request (identity required).
 * Each tells the thread what changed, so the owner sees the effect of what they said.
 */
abstract class OwnerControl<I extends { readonly taskId: string }> {
  constructor(protected readonly deps: TaskDeps) {}

  execute(input: I, identity?: RunIdentity): Promise<void> {
    if (identity !== undefined) requireDispatcher(identity);
    const actor = identity === undefined ? 'owner' : 'agent';
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadTask(tx, input.taskId);
      const change = this.apply(task, input);
      if (change === null) return;
      const changed = await this.deps.writer.update(
        tx,
        outbox,
        change.task,
        change.event,
        actor,
        change.data,
      );
      await this.deps.messages.post(tx, outbox, {
        threadId: changed.threadId,
        taskId: changed.id,
        kind: 'system',
        body: { text: change.text },
      });
      if (change.resume) outbox.resumeQueued();
    });
  }

  protected abstract apply(task: Task, input: I): Change | null;

  protected now(): string {
    return this.deps.clock.now();
  }
}

export class HoldTask extends OwnerControl<{ readonly taskId: string; readonly reason?: string }> {
  protected apply(task: Task, input: { readonly reason?: string }): Change | null {
    if (task.held) return null;
    return {
      task: holdTask(task, this.now()),
      event: 'task_held',
      data: { reason: input.reason ?? null },
      text: `${task.id} is on hold: no worker run starts until you resume it.`,
    };
  }
}

export class ResumeTask extends OwnerControl<{ readonly taskId: string }> {
  protected apply(task: Task): Change | null {
    if (!task.held) return null;
    return {
      task: resumeTask(task, this.now()),
      event: 'task_resumed',
      data: {},
      text: `${task.id} is resumed; queued work starts when a worker slot is free.`,
      resume: true,
    };
  }
}

export class SetTaskModel extends OwnerControl<{
  readonly taskId: string;
  readonly model: TaskModel;
}> {
  protected apply(task: Task, input: { readonly model: TaskModel }): Change | null {
    if (task.model === input.model) return null;
    return {
      task: setTaskModel(task, input.model, this.now()),
      event: 'model_set',
      data: { from: task.model, to: input.model },
      text: `${task.id} runs on ${input.model} from its next worker run.`,
    };
  }
}
