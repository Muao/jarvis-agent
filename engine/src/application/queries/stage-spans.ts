import type { TaskDetailDto } from '@jarvis/shared';
import { toMs, type Task, type TaskEvent } from '../../domain/index.js';

export type StageSpan = TaskDetailDto['stages'][number];

const WITH_REASON = ['Blocked', 'Failed', 'Cancelled'];

/**
 * The stage timeline (ADM-02): the task starts in Intake, and every `stage_changed` journal row closes the
 * current span and opens the next. A stage entered twice (Fixing after PR Open, say) is two spans.
 */
export function stageSpans(
  task: Pick<Task, 'startedAt'>,
  journal: readonly TaskEvent[],
): StageSpan[] {
  const spans: StageSpan[] = [
    { stage: 'Intake', enteredAt: task.startedAt, exitedAt: null, reason: null },
  ];
  for (const event of journal) {
    if (event.type !== 'stage_changed') continue;
    const to = event.data['to'] as StageSpan['stage'];
    const reason = event.data['reason'];
    const last = spans.at(-1);
    if (last !== undefined) spans[spans.length - 1] = { ...last, exitedAt: event.at };
    spans.push({
      stage: to,
      enteredAt: event.at,
      exitedAt: null,
      reason: WITH_REASON.includes(to) && typeof reason === 'string' ? reason : null,
    });
  }
  return spans;
}

/** The stage a task was in at `time`, or null when `time` is before the task began. */
export function stageAt(spans: readonly StageSpan[], time: string): StageSpan['stage'] | null {
  let found: StageSpan['stage'] | null = null;
  for (const span of spans) {
    if (toMs(span.enteredAt) <= toMs(time)) found = span.stage;
  }
  return found;
}
