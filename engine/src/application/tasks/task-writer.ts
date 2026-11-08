import type { TaskStage } from '@jarvis/shared';
import {
  taskEvent,
  transition,
  type EventActor,
  type Task,
  type TaskEvent,
  type TransitionCause,
} from '../../domain/index.js';
import type { Outbox } from '../transaction.js';
import type { Clock } from '../ports/clock.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { StatusCard } from './status-card.js';

/**
 * The one place a task is written: the task row, its journal event (ADR-0008) and its status card
 * always change together, inside the caller's transaction.
 */
export class TaskWriter {
  constructor(private readonly deps: { readonly clock: Clock; readonly statusCard: StatusCard }) {}

  /** A stage change; the domain validates it and builds the journal event. */
  async move(
    tx: Repositories,
    outbox: Outbox,
    task: Task,
    to: TaskStage,
    input: { readonly cause: TransitionCause; readonly reason?: string },
  ): Promise<Task> {
    const moved = transition(task, to, { ...input, at: this.deps.clock.now() });
    await this.persist(tx, outbox, moved.task, moved.event);
    outbox.info(`task ${task.id} moved ${task.stage} -> ${to}`, {
      event: 'task.stage',
      taskId: task.id,
      threadId: task.threadId,
    });
    return moved.task;
  }

  /** A change that is not a stage change (counters, PR link, first save of a new task). */
  async update(
    tx: Repositories,
    outbox: Outbox,
    task: Task,
    type: string,
    actor: EventActor,
    data: Readonly<Record<string, unknown>> = {},
  ): Promise<Task> {
    const at = this.deps.clock.now();
    const next: Task = { ...task, updatedAt: at };
    await this.persist(tx, outbox, next, taskEvent(task.id, type, at, actor, data));
    return next;
  }

  /** A journal entry without a change to the task (a note, a received input, a passed check). */
  async note(
    tx: Repositories,
    taskId: string,
    type: string,
    actor: EventActor,
    data: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await tx.journal.append(taskEvent(taskId, type, this.deps.clock.now(), actor, data));
  }

  private async persist(
    tx: Repositories,
    outbox: Outbox,
    task: Task,
    event: TaskEvent,
  ): Promise<void> {
    await tx.tasks.save(task);
    await tx.journal.append(event);
    await this.deps.statusCard.refresh(tx, outbox, task);
    outbox.taskChanged(task);
  }
}
