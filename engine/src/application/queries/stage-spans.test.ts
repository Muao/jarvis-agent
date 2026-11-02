import { describe, expect, it } from 'vitest';
import { taskEvent } from '../../domain/index.js';
import { stageAt, stageSpans } from './stage-spans.js';

const t = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 10, minutes)).toISOString();
const change = (minutes: number, from: string, to: string, reason: string | null = null) =>
  taskEvent('T-1', 'stage_changed', t(minutes), 'system', { from, to, cause: 'x', reason });

describe('stageSpans', () => {
  it('starts in Intake and gives a stage entered twice two spans', () => {
    const spans = stageSpans({ startedAt: t(0) }, [
      change(1, 'Intake', 'Context'),
      change(5, 'Context', 'Spec Review'),
      taskEvent('T-1', 'owner_input', t(6), 'owner'),
      change(7, 'Spec Review', 'Context'),
      change(9, 'Context', 'Spec Review'),
    ]);

    expect(spans.map((s) => [s.stage, s.enteredAt, s.exitedAt])).toEqual([
      ['Intake', t(0), t(1)],
      ['Context', t(1), t(5)],
      ['Spec Review', t(5), t(7)],
      ['Context', t(7), t(9)],
      ['Spec Review', t(9), null],
    ]);
  });

  it('keeps the reason only on Blocked, Failed and Cancelled', () => {
    const spans = stageSpans({ startedAt: t(0) }, [
      change(1, 'Intake', 'Context', 'ignored'),
      change(2, 'Context', 'Blocked', 'Which db?'),
      change(3, 'Blocked', 'Cancelled', 'not needed'),
    ]);

    expect(spans.map((s) => s.reason)).toEqual([null, null, 'Which db?', 'not needed']);
  });
});

describe('stageAt', () => {
  const spans = stageSpans({ startedAt: t(0) }, [change(2, 'Intake', 'Context')]);

  it('finds the stage in force at a time', () => {
    expect(stageAt(spans, t(1))).toBe('Intake');
    expect(stageAt(spans, t(2))).toBe('Context');
    expect(stageAt(spans, t(30))).toBe('Context');
  });

  it('is null before the task began', () => {
    expect(stageAt(spans, t(-1))).toBeNull();
  });
});
