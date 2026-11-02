import type { TaskStage } from '@jarvis/shared';
import type { Message, Task } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { Outbox } from '../transaction.js';
import type { ThreadMessages } from '../conversation/thread-messages.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { Repositories } from '../ports/unit-of-work.js';

type StatusBody = BodyOf<'status'>;
type Step = StatusBody['steps'][number];

const STEP_LABELS = ['context', 'spec', 'implementing', 'verifying', 'reviewing', 'pr'] as const;

/** Index of the step a stage is working on; `STEP_LABELS.length` means everything is done. */
const ACTIVE_STEP: Readonly<Record<TaskStage, number>> = {
  Intake: 0,
  Context: 0,
  'Spec Review': 1,
  Implementing: 2,
  Verifying: 3,
  Reviewing: 4,
  'PR Open': 5,
  Fixing: 5,
  Done: STEP_LABELS.length,
  // Blocked and Failed show the stage they will return to; Cancelled keeps what the card showed.
  Blocked: 0,
  Failed: 0,
  Cancelled: 0,
};

function stepsFor(task: Task, previous: readonly Step[] | null): Step[] {
  if (task.stage === 'Cancelled') {
    const frozen = previous ?? STEP_LABELS.map((label) => ({ label, state: 'pending' as const }));
    return frozen.map((s) => (s.state === 'active' ? { ...s, state: 'pending' as const } : s));
  }
  const waiting = task.stage === 'Blocked' || task.stage === 'Failed';
  const active =
    waiting && task.resumeStage !== null ? ACTIVE_STEP[task.resumeStage] : ACTIVE_STEP[task.stage];
  return STEP_LABELS.map((label, index) => ({
    label,
    state: index < active ? 'done' : index === active ? 'active' : 'pending',
  }));
}

/**
 * SLK-07: exactly one status message per task. It is created on the first refresh and afterwards
 * replaced in place, never posted again.
 */
export class StatusCard {
  constructor(
    private readonly deps: {
      readonly messages: ThreadMessages;
      readonly config: ConfigProvider;
    },
  ) {}

  async refresh(tx: Repositories, outbox: Outbox, task: Task): Promise<Message> {
    const existing = await tx.messages.statusCardOf(task.id);
    const { limits } = this.deps.config.current();
    const previous = existing === null ? null : (existing.body as StatusBody).steps;
    const body: StatusBody = {
      taskId: task.id,
      stage: task.stage,
      workerSessionId: task.workerSessionId,
      startedAt: task.startedAt,
      steps: stepsFor(task, previous),
      checks: { used: task.counters.checkRetries, max: limits.checkRetries },
      ciFixes: { used: task.counters.ciFixRounds, max: limits.ciFixRounds },
      reviews: { used: task.counters.reviewRounds, max: limits.reviewRounds },
    };
    if (existing === null) {
      return this.deps.messages.post(tx, outbox, {
        threadId: task.threadId,
        taskId: task.id,
        kind: 'status',
        body,
      });
    }
    const next: Message = { ...existing, body };
    await this.deps.messages.replace(tx, outbox, next);
    return next;
  }
}
