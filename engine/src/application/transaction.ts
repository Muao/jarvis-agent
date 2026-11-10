import type { StreamEvent } from '@jarvis/shared';
import type { Message, Task } from '../domain/index.js';
import type { EventBus } from './ports/event-bus.js';
import type { LogContext, Logger } from './ports/logger.js';
import type { OwnerChannel } from './ports/owner-channel.js';
import type { RunCoordinator, WorkerRunReason } from './ports/run-coordinator.js';
import type { UnitOfWork, Repositories } from './ports/unit-of-work.js';

/** The ports a use case talks to after its transaction committed. */
export interface Notifiers {
  readonly owner: OwnerChannel;
  readonly events: EventBus;
  readonly runs: RunCoordinator;
  readonly logger: Logger;
}

type Effect =
  | { readonly type: 'message_created'; readonly message: Message }
  | { readonly type: 'message_updated'; readonly message: Message }
  | { readonly type: 'event'; readonly event: StreamEvent }
  | { readonly type: 'log'; readonly message: string; readonly context: LogContext }
  | { readonly type: 'dispatcher_turn'; readonly threadId: string }
  | { readonly type: 'worker_run'; readonly taskId: string; readonly reason: WorkerRunReason }
  | { readonly type: 'deliver_to_worker'; readonly taskId: string }
  | { readonly type: 'stop_task_runs'; readonly taskId: string }
  | { readonly type: 'resume_queued' };

/**
 * What a use case wants to happen once its transaction has committed. Collected inside the unit
 * of work, flushed only after it resolves, so a rollback sends nothing.
 */
export class Outbox {
  private readonly effects: Effect[] = [];

  messageCreated(message: Message): void {
    this.effects.push({ type: 'message_created', message });
  }

  /** Several updates of one message in one transaction collapse into the last. */
  messageUpdated(message: Message): void {
    const known = this.effects.findIndex(
      (e) => e.type === 'message_updated' && e.message.id === message.id,
    );
    if (known >= 0) this.effects.splice(known, 1);
    this.effects.push({ type: 'message_updated', message });
  }

  threadChanged(threadId: string): void {
    this.publish({ type: 'thread', id: threadId });
  }

  taskChanged(task: Pick<Task, 'id' | 'threadId'>): void {
    this.publish({ type: 'task', id: task.id });
    this.publish({ type: 'thread', id: task.threadId });
    this.publish({ type: 'overview' });
  }

  /** A lifecycle line at `info`; written only if the transaction committed. */
  info(message: string, context: LogContext): void {
    this.effects.push({ type: 'log', message, context });
  }

  requestDispatcherTurn(threadId: string): void {
    this.effects.push({ type: 'dispatcher_turn', threadId });
  }

  requestWorkerRun(taskId: string, reason: WorkerRunReason): void {
    this.effects.push({ type: 'worker_run', taskId, reason });
  }

  deliverToWorker(taskId: string): void {
    this.effects.push({ type: 'deliver_to_worker', taskId });
  }

  stopTaskRuns(taskId: string): void {
    this.effects.push({ type: 'stop_task_runs', taskId });
  }

  /** Start whatever queued work fits now (a held task was resumed). */
  resumeQueued(): void {
    this.effects.push({ type: 'resume_queued' });
  }

  /**
   * Best-effort: the state is already committed, so a failing notification is logged and the rest
   * still run; it never fails the use case.
   */
  async flush(to: Notifiers): Promise<void> {
    for (const effect of this.effects) {
      try {
        await this.apply(effect, to);
      } catch (error) {
        to.logger.warn('after-commit effect failed', {
          effect: effect.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private apply(effect: Effect, to: Notifiers): Promise<void> {
    switch (effect.type) {
      case 'message_created':
        return to.owner.deliver(effect.message);
      case 'message_updated':
        return to.owner.updated(effect.message);
      case 'event':
        return to.events.publish(effect.event);
      case 'log':
        to.logger.info(effect.message, effect.context);
        return Promise.resolve();
      case 'dispatcher_turn':
        return to.runs.requestDispatcherTurn(effect.threadId);
      case 'worker_run':
        return to.runs.requestWorkerRun(effect.taskId, effect.reason);
      case 'deliver_to_worker':
        return to.runs.deliverToWorker(effect.taskId);
      case 'stop_task_runs':
        return to.runs.stopTaskRuns(effect.taskId);
      case 'resume_queued':
        return to.runs.resumeQueued();
    }
  }

  private publish(event: StreamEvent): void {
    const key = JSON.stringify(event);
    const known = this.effects.some((e) => e.type === 'event' && JSON.stringify(e.event) === key);
    if (!known) this.effects.push({ type: 'event', event });
  }
}

export interface TransactionDeps {
  readonly uow: UnitOfWork;
  readonly notifiers: Notifiers;
}

/** Run `work` in one transaction, then (only if it committed) send what it queued in the outbox. */
export async function transact<T>(
  deps: TransactionDeps,
  work: (tx: Repositories, outbox: Outbox) => Promise<T>,
): Promise<T> {
  const outbox = new Outbox();
  const result = await deps.uow.run((tx) => work(tx, outbox));
  await outbox.flush(deps.notifiers);
  return result;
}
