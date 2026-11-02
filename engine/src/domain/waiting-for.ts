import type { WaitingFor } from '@jarvis/shared';
import { isTerminal, type Task } from './task.js';

export interface WaitingForInput {
  /** The task has work to run but no worker slot yet. */
  readonly queued: boolean;
  /** A decision, question or permission card for this task is unanswered. */
  readonly pendingOwnerCard: boolean;
  /** CI of the current head is green; the open PR is then waiting for review. Defaults to false. */
  readonly ciGreen?: boolean;
}

/** Derived, never stored (plan "Task stages"). */
export function waitingFor(task: Pick<Task, 'stage'>, input: WaitingForInput): WaitingFor {
  if (isTerminal(task.stage)) return '—';
  if (task.stage === 'Spec Review' || task.stage === 'Blocked' || input.pendingOwnerCard) {
    return 'owner';
  }
  if (input.queued) return 'worker slot';
  if (task.stage === 'PR Open') return input.ciGreen === true ? 'review' : 'ci';
  return '—';
}
