import { TASK_STAGES, type TaskStage } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  CAUSE_ACTOR,
  TRANSITIONS,
  attachPullRequest,
  assignWorkerSession,
  canTransition,
  createTask,
  isActive,
  isTerminal,
  recordCheckFailure,
  recordCiFailure,
  recordReviewRound,
  setTargetRepo,
  transition,
  type Task,
  type TransitionCause,
} from './task.js';

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T10:05:00.000Z';

const base = createTask({
  id: 'T-1',
  threadId: 'th-1',
  title: 'Add login',
  branch: 'jarvis/T-1',
  at: T0,
});
const at = (stage: TaskStage, extra: Partial<Task> = {}): Task => ({ ...base, stage, ...extra });
const move = (task: Task, to: TaskStage, cause: TransitionCause = 'stage_reported') =>
  transition(task, to, { cause, at: T1 });

describe('createTask', () => {
  it('starts in Intake with zeroed counters and no PR', () => {
    expect(base).toMatchObject({
      stage: 'Intake',
      resumeStage: null,
      pr: null,
      workerSessionId: null,
      reason: null,
      counters: { checkRetries: 0, ciFixRounds: 0, reviewRounds: 0 },
      startedAt: T0,
      updatedAt: T0,
    });
  });
});

describe('transition table', () => {
  const legal: [TaskStage, TaskStage][] = [
    ['Intake', 'Context'],
    ['Context', 'Spec Review'],
    ['Spec Review', 'Context'],
    ['Spec Review', 'Implementing'],
    ['Implementing', 'Verifying'],
    ['Implementing', 'Reviewing'],
    ['Verifying', 'Implementing'],
    ['Verifying', 'Reviewing'],
    ['Verifying', 'PR Open'],
    ['Reviewing', 'Implementing'],
    ['Reviewing', 'Verifying'],
    ['Reviewing', 'PR Open'],
    ['PR Open', 'Fixing'],
    ['PR Open', 'Done'],
    ['Fixing', 'PR Open'],
  ];

  it.each(legal)('allows %s -> %s', (from, to) => {
    const { task, event } = move(at(from), to);
    expect(task.stage).toBe(to);
    expect(task.updatedAt).toBe(T1);
    expect(event).toMatchObject({
      taskId: 'T-1',
      type: 'stage_changed',
      at: T1,
      data: { from, to },
    });
  });

  const nonTerminal = TASK_STAGES.filter((s) => !isTerminal(s) && s !== 'Blocked');

  it.each(nonTerminal)('allows %s -> Blocked and -> Cancelled', (from) => {
    expect(move(at(from), 'Blocked').task).toMatchObject({ stage: 'Blocked', resumeStage: from });
    expect(move(at(from), 'Cancelled').task.stage).toBe('Cancelled');
  });

  it.each(nonTerminal)('allows %s -> Failed', (from) => {
    expect(move(at(from), 'Failed').task.stage).toBe('Failed');
  });

  it('rejects every pair that is not in the table, for every stage', () => {
    for (const from of TASK_STAGES) {
      for (const to of TASK_STAGES) {
        const task = at(
          from,
          from === 'Blocked' || from === 'Failed' ? { resumeStage: 'Context' } : {},
        );
        const allowed =
          from === 'Blocked'
            ? to === 'Context' || to === 'Cancelled'
            : from === 'Failed'
              ? to === 'Context'
              : TRANSITIONS[from].includes(to);
        expect(canTransition(task, to), `${from} -> ${to}`).toBe(allowed);
        if (!allowed || from === 'Failed') {
          expect(() => move(task, to), `${from} -> ${to}`).toThrowError(DomainError);
        }
      }
    }
  });

  it('throws DomainError with code illegal_transition', () => {
    try {
      move(at('Intake'), 'Done');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('illegal_transition');
    }
  });

  it('does not allow skipping the spec approval', () => {
    expect(canTransition(at('Context'), 'Implementing')).toBe(false);
    expect(canTransition(at('Intake'), 'Implementing')).toBe(false);
  });

  it('does not mutate the input task', () => {
    const before = at('Context');
    const snapshot = structuredClone(before);
    move(before, 'Spec Review');
    expect(before).toEqual(snapshot);
  });
});

describe('terminal stages', () => {
  it.each(['Done', 'Cancelled'] as const)('%s accepts nothing', (stage) => {
    expect(isTerminal(stage)).toBe(true);
    for (const to of TASK_STAGES) {
      expect(canTransition(at(stage), to)).toBe(false);
      expect(() => move(at(stage), to)).toThrowError(DomainError);
    }
  });

  it('isActive is the inverse of isTerminal', () => {
    for (const stage of TASK_STAGES) expect(isActive({ stage })).toBe(!isTerminal(stage));
  });
});

describe('Failed and owner retry', () => {
  const failed = (counters = { checkRetries: 3, ciFixRounds: 1, reviewRounds: 0 }) =>
    transition({ ...at('Verifying'), counters }, 'Failed', {
      cause: 'checks_exhausted',
      at: T1,
      reason: 'lint',
    }).task;

  it('stores the stage it failed in', () => {
    expect(failed()).toMatchObject({ stage: 'Failed', resumeStage: 'Verifying', reason: 'lint' });
  });

  it('is final for automation: only owner_retry leaves it', () => {
    const t = failed();
    expect(isTerminal(t.stage)).toBe(true);
    expect(() => move(t, 'Verifying')).toThrowError(DomainError);
    expect(() => transition(t, 'Verifying', { cause: 'task_timeout', at: T1 })).toThrowError(
      DomainError,
    );
  });

  it('owner_retry returns to the failed stage with fresh counters', () => {
    const { task, event } = transition(failed(), 'Verifying', { cause: 'owner_retry', at: T1 });
    expect(task).toMatchObject({
      stage: 'Verifying',
      resumeStage: null,
      reason: null,
      counters: { checkRetries: 0, ciFixRounds: 0, reviewRounds: 0 },
    });
    expect(event.actor).toBe('owner');
  });

  it('owner_retry cannot go to any other stage', () => {
    expect(() => transition(failed(), 'Context', { cause: 'owner_retry', at: T1 })).toThrowError(
      DomainError,
    );
  });
});

describe('Blocked and resume', () => {
  it('owner_answered grants fresh attempts; other causes keep counters', () => {
    const counters = { checkRetries: 1, ciFixRounds: 2, reviewRounds: 3 };
    const blocked = transition({ ...at('PR Open'), counters }, 'Blocked', {
      cause: 'rounds_exhausted',
      at: T1,
    }).task;
    expect(blocked.counters).toEqual(counters);
    const resumed = transition(blocked, 'PR Open', { cause: 'owner_answered', at: T1 }).task;
    expect(resumed.counters).toEqual({ checkRetries: 0, ciFixRounds: 0, reviewRounds: 0 });
  });

  it('stores the stage it was entered from, with the reason', () => {
    const { task } = transition(at('Implementing'), 'Blocked', {
      cause: 'ask_owner',
      at: T1,
      reason: 'Which database?',
    });
    expect(task).toMatchObject({
      stage: 'Blocked',
      resumeStage: 'Implementing',
      reason: 'Which database?',
    });
  });

  it('returns to resumeStage and clears resumeStage and reason', () => {
    const blocked = transition(at('PR Open'), 'Blocked', {
      cause: 'rounds_exhausted',
      at: T1,
      reason: 'CI keeps failing',
    }).task;
    const { task, event } = transition(blocked, 'PR Open', { cause: 'owner_answered', at: T1 });
    expect(task).toMatchObject({ stage: 'PR Open', resumeStage: null, reason: null });
    expect(event).toMatchObject({
      actor: 'owner',
      data: { from: 'Blocked', to: 'PR Open', cause: 'owner_answered' },
    });
  });

  it('cannot go anywhere but resumeStage or Cancelled', () => {
    const blocked = move(at('Context'), 'Blocked').task;
    expect(canTransition(blocked, 'Context')).toBe(true);
    expect(canTransition(blocked, 'Cancelled')).toBe(true);
    for (const to of [
      'Spec Review',
      'Implementing',
      'PR Open',
      'Failed',
      'Done',
      'Blocked',
    ] as const) {
      expect(canTransition(blocked, to)).toBe(false);
    }
  });

  it('cannot be entered twice', () => {
    expect(() => move(move(at('Context'), 'Blocked').task, 'Blocked')).toThrowError(DomainError);
  });

  it('can be cancelled with a reason', () => {
    const blocked = move(at('Fixing'), 'Blocked').task;
    const { task } = transition(blocked, 'Cancelled', {
      cause: 'owner_cancelled',
      at: T1,
      reason: 'not needed',
    });
    expect(task).toMatchObject({ stage: 'Cancelled', reason: 'not needed', resumeStage: null });
  });

  it('keeps no reason on ordinary stages', () => {
    const { task } = transition(at('Context'), 'Spec Review', {
      cause: 'spec_submitted',
      at: T1,
      reason: 'ignored',
    });
    expect(task.reason).toBeNull();
  });
});

describe('journal event', () => {
  it('records the actor derived from the cause', () => {
    const cases: [TransitionCause, TaskStage, TaskStage, string][] = [
      ['spec_approved', 'Spec Review', 'Implementing', 'owner'],
      ['spec_submitted', 'Context', 'Spec Review', 'agent'],
      ['worker_started', 'Intake', 'Context', 'system'],
    ];
    for (const [cause, from, to, actor] of cases) {
      const { event } = transition(at(from), to, { cause, at: T1 });
      expect(event.actor).toBe(actor);
      expect(event.data).toMatchObject({ cause });
    }
  });

  it('has an actor for every cause', () => {
    expect(Object.keys(CAUSE_ACTOR)).toHaveLength(18);
  });

  it('carries the reason for Failed', () => {
    const { event } = transition(at('Verifying'), 'Failed', {
      cause: 'checks_exhausted',
      at: T1,
      reason: 'lint',
    });
    expect(event.data).toMatchObject({ to: 'Failed', reason: 'lint' });
  });
});

describe('field helpers', () => {
  it('attaches a pull request', () => {
    const task = attachPullRequest(base, { number: 7, url: 'https://github.com/o/r/pull/7' }, T1);
    expect(task.pr).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' });
    expect(task.updatedAt).toBe(T1);
  });

  it('assigns the worker session', () => {
    expect(assignWorkerSession(base, 'sess-1', T1).workerSessionId).toBe('sess-1');
  });

  it('starts with no target repo', () => {
    expect(base.targetRepo).toBeNull();
  });

  it('sets the target repo', () => {
    const task = setTargetRepo(base, { owner: 'owner', name: 'name' }, T1);
    expect(task.targetRepo).toEqual({ owner: 'owner', name: 'name' });
    expect(task.updatedAt).toBe(T1);
  });
});

describe('counters', () => {
  it('check failures retry until the limit, then fail without counting further', () => {
    let task = base;
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = recordCheckFailure(task, { checkRetries: 3 });
      task = result.task;
      outcomes.push(result.outcome);
    }
    expect(outcomes).toEqual(['retry', 'retry', 'retry', 'fail', 'fail']);
    expect(task.counters.checkRetries).toBe(3);
  });

  it('ci failures give ciFixRounds fix rounds, then block', () => {
    const first = recordCiFailure(base, { ciFixRounds: 2 });
    const second = recordCiFailure(first.task, { ciFixRounds: 2 });
    const third = recordCiFailure(second.task, { ciFixRounds: 2 });
    expect([first.outcome, second.outcome, third.outcome]).toEqual(['fix', 'fix', 'block']);
    expect(third.task.counters.ciFixRounds).toBe(2);
  });

  it('review rounds give reviewRounds rounds, then block', () => {
    let task = base;
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = recordReviewRound(task, { reviewRounds: 3 });
      task = result.task;
      outcomes.push(result.outcome);
    }
    expect(outcomes).toEqual(['fix', 'fix', 'fix', 'block']);
  });

  it('counters are independent', () => {
    const { task } = recordCiFailure(base, { ciFixRounds: 2 });
    expect(task.counters).toEqual({ checkRetries: 0, ciFixRounds: 1, reviewRounds: 0 });
  });

  it('a limit of zero allows nothing', () => {
    expect(recordCheckFailure(base, { checkRetries: 0 }).outcome).toBe('fail');
  });

  it('does not mutate the input task', () => {
    recordReviewRound(base, { reviewRounds: 3 });
    expect(base.counters.reviewRounds).toBe(0);
  });
});
