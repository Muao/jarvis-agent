import { MessageKindSchema, type MessageKind } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { answerCard, isAnswered, isCard, type Message } from './message.js';
import { createTask } from './task.js';
import { createThread, routeOwnerMessage, touchThread } from './thread.js';
import { waitingFor } from './waiting-for.js';

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T10:05:00.000Z';

const card = (kind: MessageKind = 'decision'): Message => ({
  id: 'm-1',
  threadId: 'th-1',
  taskId: 'T-1',
  kind,
  body: { title: 'Approve the spec?' },
  at: T0,
  answer: null,
  answeredAt: null,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'other';
  }
  return undefined;
};

describe('answerCard', () => {
  it.each(['decision', 'question', 'permission'] as const)('answers a %s card once', (kind) => {
    const answered = answerCard(card(kind), { choice: 'approve' }, T1);
    expect(answered).toMatchObject({ answer: { choice: 'approve' }, answeredAt: T1 });
    expect(isAnswered(answered)).toBe(true);
  });

  it('rejects a second answer', () => {
    const answered = answerCard(card(), { choice: 'approve' }, T1);
    expect(codeOf(() => answerCard(answered, { choice: 'reject' }, T1))).toBe('already_answered');
    expect(answered.answer).toEqual({ choice: 'approve' });
  });

  it('rejects an answer for a cancelled task', () => {
    const cancelled = { stage: 'Cancelled' as const };
    expect(codeOf(() => answerCard(card(), {}, T1, cancelled))).toBe('task_cancelled');
  });

  it('accepts an answer for tasks in any other stage', () => {
    expect(answerCard(card(), {}, T1, { stage: 'Blocked' }).answeredAt).toBe(T1);
  });

  it('only cards can be answered', () => {
    for (const kind of MessageKindSchema.options.filter((k) => !isCard({ kind: k }))) {
      expect(codeOf(() => answerCard(card(kind), {}, T1))).toBe('not_a_card');
    }
  });

  it('does not mutate the original message', () => {
    const original = card();
    answerCard(original, { choice: 'approve' }, T1);
    expect(original.answer).toBeNull();
  });
});

describe('thread', () => {
  it('creates and touches', () => {
    const thread = createThread({ id: 'th-1', title: 'Hello', at: T0 });
    expect(thread).toEqual({
      id: 'th-1',
      title: 'Hello',
      createdAt: T0,
      updatedAt: T0,
      archivedAt: null,
    });
    expect(touchThread(thread, T1).updatedAt).toBe(T1);
  });
});

describe('routeOwnerMessage', () => {
  const active = { stage: 'Implementing' as const };

  it('goes to the worker while the thread has an active task', () => {
    expect(routeOwnerMessage({ task: active, dispatcherBusy: false })).toBe('worker_input');
    expect(routeOwnerMessage({ task: { stage: 'Blocked' }, dispatcherBusy: true })).toBe(
      'worker_input',
    );
  });

  it('goes to the dispatcher without a task or with a finished one', () => {
    expect(routeOwnerMessage({ task: null, dispatcherBusy: false })).toBe('dispatcher');
    expect(routeOwnerMessage({ task: { stage: 'Done' }, dispatcherBusy: false })).toBe(
      'dispatcher',
    );
    expect(routeOwnerMessage({ task: { stage: 'Cancelled' }, dispatcherBusy: false })).toBe(
      'dispatcher',
    );
  });

  it('queues behind a running dispatcher turn', () => {
    expect(routeOwnerMessage({ task: null, dispatcherBusy: true })).toBe('dispatcher_queued');
  });
});

describe('waitingFor', () => {
  const task = createTask({ id: 'T-1', threadId: 'th-1', title: 't', branch: 'b', at: T0 });
  const idle = { queued: false, pendingOwnerCard: false };
  const stage = (s: (typeof task)['stage']) => ({ ...task, stage: s });

  it('is owner for Spec Review and Blocked', () => {
    expect(waitingFor(stage('Spec Review'), idle)).toBe('owner');
    expect(waitingFor(stage('Blocked'), idle)).toBe('owner');
  });

  it('is owner for any active task with a pending card', () => {
    expect(waitingFor(stage('Implementing'), { ...idle, pendingOwnerCard: true })).toBe('owner');
  });

  it('is worker slot when queued', () => {
    expect(waitingFor(stage('Intake'), { ...idle, queued: true })).toBe('worker slot');
  });

  it('prefers owner over worker slot', () => {
    expect(waitingFor(stage('Context'), { queued: true, pendingOwnerCard: true })).toBe('owner');
  });

  it('is ci then review for PR Open', () => {
    expect(waitingFor(stage('PR Open'), idle)).toBe('ci');
    expect(waitingFor(stage('PR Open'), { ...idle, ciGreen: true })).toBe('review');
  });

  it('is — for working stages and terminal stages, even with stale flags', () => {
    expect(waitingFor(stage('Implementing'), idle)).toBe('—');
    expect(waitingFor(stage('Fixing'), idle)).toBe('—');
    for (const s of ['Done', 'Failed', 'Cancelled'] as const) {
      expect(waitingFor(stage(s), { queued: true, pendingOwnerCard: true })).toBe('—');
    }
  });
});
