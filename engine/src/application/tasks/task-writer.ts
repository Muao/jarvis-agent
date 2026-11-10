import type { TaskStage } from '@jarvis/shared';
import {
  isTerminal,
  taskEvent,
  transition,
  type EventActor,
  type Task,
  type TaskEvent,
  type TransitionCause,
} from '../../domain/index.js';
import type { ThreadMessages } from '../conversation/thread-messages.js';
import { memorySummaryLine } from '../profile/memory-summary.js';
import type { Outbox } from '../transaction.js';
import type { Clock } from '../ports/clock.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { StatusCard } from './status-card.js';

/**
 * The one place a task is written: the task row, its journal event (ADR-0008) and its status card
 * always change together, inside the caller's transaction.
 */
export class TaskWriter {
  constructor(
    private readonly deps: {
      readonly clock: Clock;
      readonly statusCard: StatusCard;
      readonly messages: ThreadMessages;
      /** ADR-0021: is the memory over its cap for this task's repository right now? */
      readonly memoryOverCap?: (task: Task) => Promise<boolean>;
    },
  ) {}

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
    if (isTerminal(to)) await this.sayMemory(tx, outbox, moved.task);
    return moved.task;
  }

  /**
   * DSP-04: a worker in `PR Open` calls `open_pr` to push new commits. Only an owner message (or an
   * answer to its question) starts a run there — CI and review move the task to `Fixing` themselves —
   * so the push is the owner's request and the task moves to `Fixing` now, like a review comment
   * would move it. A message that asks for no change (a question, a retro) never reaches this and
   * the task stays in `PR Open`, watched. Owner-driven, so it uses no CI-fix or review round.
   */
  async reopenForPush(tx: Repositories, outbox: Outbox, task: Task): Promise<Task> {
    if (task.kind !== 'build' || task.stage !== 'PR Open') return task;
    return this.move(tx, outbox, task, 'Fixing', {
      cause: 'owner_request',
      reason: 'open_pr from PR Open',
    });
  }

  /** ADR-0021: a task that touched the memory ends with one line saying what it did there. */
  private async sayMemory(tx: Repositories, outbox: Outbox, task: Task): Promise<void> {
    const events = await tx.journal.list(task.id);
    // Only worth a profile read when there is a line to append it to.
    const probe = memorySummaryLine(events);
    if (probe === null) return;
    const capped = (await this.deps.memoryOverCap?.(task)) ?? false;
    const text = memorySummaryLine(events, capped) ?? probe;
    await this.deps.messages.post(tx, outbox, {
      threadId: task.threadId,
      taskId: task.id,
      kind: 'system',
      body: { text },
    });
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
