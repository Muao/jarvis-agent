import { describe, expect, it } from 'vitest';
import { TASK_STAGES } from '../enums.js';
import { ApiErrorSchema } from './errors.js';
import { AnswerMessageBodySchema, MessageDtoSchema, PostMessageBodySchema } from './threads.js';
import { TaskDtoSchema } from './tasks.js';
import { ConfigDtoSchema } from './config.js';

const at = '2026-10-26T10:00:00.000Z';
const counter = { used: 1, max: 3 };

describe('enums', () => {
  it('lists the task stages exactly', () => {
    expect(TASK_STAGES).toEqual([
      'Intake',
      'Context',
      'Spec Review',
      'Implementing',
      'Verifying',
      'Reviewing',
      'PR Open',
      'Fixing',
      'Done',
      'Blocked',
      'Failed',
      'Cancelled',
    ]);
  });
});

describe('ApiErrorSchema', () => {
  it('requires code and message, details optional', () => {
    expect(
      ApiErrorSchema.safeParse({ code: 'task_not_found', message: 'No such task' }).success,
    ).toBe(true);
    expect(ApiErrorSchema.safeParse({ message: 'x' }).success).toBe(false);
  });
});

describe('request bodies', () => {
  it('rejects empty text and unknown keys', () => {
    expect(PostMessageBodySchema.safeParse({ text: '' }).success).toBe(false);
    expect(PostMessageBodySchema.safeParse({ text: 'hi', threadId: 't' }).success).toBe(false);
  });

  it('accepts decision and question answers', () => {
    expect(AnswerMessageBodySchema.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(
      AnswerMessageBodySchema.safeParse({ decision: 'request_changes', comment: 'tighten' })
        .success,
    ).toBe(true);
    expect(AnswerMessageBodySchema.safeParse({ text: 'option A' }).success).toBe(true);
    expect(AnswerMessageBodySchema.safeParse({ decision: 'allow' }).success).toBe(false);
  });
});

describe('DTOs', () => {
  it('parses a status card message and an answered decision card', () => {
    const head = {
      id: 'm1',
      threadId: 'th1',
      taskId: null,
      createdAt: at,
      answer: null,
      answeredAt: null,
    };
    const status = {
      ...head,
      kind: 'status',
      body: {
        taskId: 'T-1',
        stage: 'Implementing',
        workerSessionId: 'ses-1',
        startedAt: at,
        steps: [{ label: 'context', state: 'done' }],
        checks: counter,
        ciFixes: counter,
        reviews: counter,
      },
    };
    expect(MessageDtoSchema.parse(status)).toEqual(status);
    // A card stored before these fields existed still parses.
    const { workerSessionId, startedAt, ...oldBody } = status.body;
    expect(workerSessionId).toBe('ses-1');
    expect(startedAt).toBe(at);
    expect(MessageDtoSchema.parse({ ...status, body: oldBody })).toMatchObject({
      body: { workerSessionId: null, startedAt: null },
    });

    const decision = {
      ...head,
      kind: 'decision',
      body: { taskId: 'T-1', summary: 'Spec ready', artifacts: ['spec.md', 'plan.md'] },
      answer: { decision: 'approve' },
      answeredAt: at,
    };
    expect(MessageDtoSchema.parse(decision)).toEqual(decision);

    // ADR-0022: the card carries the check commands approval freezes.
    const withChecks = {
      ...decision,
      body: { ...decision.body, checks: ['pnpm test'], checksSource: 'agents_md' },
    };
    expect(MessageDtoSchema.parse(withChecks)).toEqual(withChecks);
    expect(
      MessageDtoSchema.safeParse({
        ...decision,
        body: { ...decision.body, checksSource: 'model' },
      }).success,
    ).toBe(false);
  });

  it('parses a task row', () => {
    const task = {
      id: 'T-12',
      threadId: 'th1',
      title: 'Add page',
      stage: 'PR Open',
      working: false,
      held: false,
      model: null,
      waitingFor: 'ci',
      branch: 'jarvis/T-12',
      prNumber: 34,
      prUrl: 'https://github.com/o/r/pull/34',
      ci: 'running',
      runCount: 3,
      costUsd: 1.25,
      updatedAt: at,
    };
    expect(TaskDtoSchema.parse(task)).toEqual(task);
  });

  it('parses valid and invalid config responses', () => {
    expect(
      ConfigDtoSchema.safeParse({
        valid: false,
        path: '/h/jarvis.config.json',
        errors: ['repo.path: Required'],
      }).success,
    ).toBe(true);
    expect(ConfigDtoSchema.safeParse({ valid: false, path: '/h/jarvis.config.json' }).success).toBe(
      false,
    );
  });
});

describe('owner message source', () => {
  const base = {
    id: 'm1',
    threadId: 't1',
    taskId: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    answer: null,
    answeredAt: null,
    kind: 'owner',
  };

  it('defaults to owner and accepts ci and review', () => {
    const plain = MessageDtoSchema.parse({ ...base, body: { text: 'hi', delivery: 'queued' } });
    expect(plain.body).toMatchObject({ source: 'owner' });
    const ci = MessageDtoSchema.parse({
      ...base,
      body: { text: 'x', delivery: 'queued', source: 'ci' },
    });
    expect(ci.body).toMatchObject({ source: 'ci' });
    expect(() =>
      MessageDtoSchema.parse({ ...base, body: { text: 'x', delivery: 'queued', source: 'bot' } }),
    ).toThrow();
  });
});
