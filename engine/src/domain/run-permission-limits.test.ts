import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { canStartRun, isStalled, isTaskTimedOut, usageLeft } from './limits.js';
import {
  decidePermission,
  isExpired,
  requestPermission,
  timeoutPermission,
  type PermissionRequest,
} from './permission.js';
import { finishRun, interruptRun, startRun, type RunOutcome } from './run.js';

const T0 = '2026-01-01T10:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'other';
  }
  return undefined;
};

describe('run', () => {
  const run = startRun({
    id: 'r-1',
    sessionId: 's-1',
    role: 'worker',
    threadId: 'th-1',
    taskId: 'T-1',
    at: T0,
  });
  const usage = { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 };
  const result = (subtype: string, message?: string): RunOutcome => ({
    type: 'result',
    subtype,
    costUsd: 0.42,
    turns: 7,
    usage,
    ...(message === undefined ? {} : { message }),
  });

  it('starts running with zero usage', () => {
    expect(run).toMatchObject({
      status: 'running',
      finishedAt: null,
      costUsd: 0,
      turns: 0,
      exitCode: null,
    });
  });

  it.each([
    ['success', 'completed'],
    ['error_max_turns', 'limit_reached'],
    ['error_max_budget_usd', 'limit_reached'],
    ['error_during_execution', 'failed'],
    ['something_new', 'failed'],
  ] as const)('maps result subtype %s to %s', (subtype, status) => {
    const finished = finishRun(run, result(subtype), at(3));
    expect(finished).toMatchObject({ status, finishedAt: at(3), costUsd: 0.42, turns: 7, usage });
    expect(finished.error === null).toBe(status === 'completed');
  });

  it('keeps the CLI message as the error', () => {
    expect(finishRun(run, result('error_during_execution', 'boom'), at(1)).error).toBe('boom');
  });

  it('maps an exit without a result to failed with the exit code', () => {
    const finished = finishRun(run, { type: 'exit', code: 137 }, at(1));
    expect(finished).toMatchObject({ status: 'failed', exitCode: 137, costUsd: 0 });
    expect(finished.error).toContain('137');
  });

  it('maps a stop to stopped and a rate limit to limit_reached', () => {
    expect(finishRun(run, { type: 'stopped' }, at(1))).toMatchObject({
      status: 'stopped',
      error: null,
    });
    expect(finishRun(run, { type: 'rate_limited' }, at(1)).status).toBe('limit_reached');
  });

  it('cannot finish or be interrupted twice', () => {
    const done = finishRun(run, { type: 'stopped' }, at(1));
    expect(codeOf(() => finishRun(done, { type: 'stopped' }, at(2)))).toBe('run_not_running');
    expect(codeOf(() => interruptRun(done, at(2)))).toBe('run_not_running');
  });

  it('marks a running run interrupted after a restart', () => {
    expect(interruptRun(run, at(9))).toMatchObject({ status: 'interrupted', finishedAt: at(9) });
  });
});

describe('permission', () => {
  const pending = (): PermissionRequest =>
    requestPermission({
      id: 'p-1',
      runId: 'r-1',
      threadId: 'th-1',
      taskId: 'T-1',
      tool: 'Bash',
      description: 'rm -rf build',
      input: { command: 'rm -rf build' },
      at: T0,
      timeoutMinutes: 30,
    });

  it('starts pending with an expiry from the timeout', () => {
    expect(pending()).toMatchObject({ status: 'pending', expiresAt: at(30), decidedAt: null });
  });

  it('isExpired is inclusive of the expiry instant', () => {
    const request = pending();
    expect(isExpired(request, at(29))).toBe(false);
    expect(isExpired(request, at(30))).toBe(true);
    expect(isExpired(request, at(31))).toBe(true);
  });

  it.each(['allow', 'deny'] as const)('can be decided %s', (decision) => {
    expect(decidePermission(pending(), decision, at(5))).toMatchObject({
      status: decision,
      decidedAt: at(5),
    });
  });

  it('is decided once', () => {
    const allowed = decidePermission(pending(), 'allow', at(5));
    expect(codeOf(() => decidePermission(allowed, 'deny', at(6)))).toBe('already_decided');
    expect(codeOf(() => timeoutPermission(allowed, at(40)))).toBe('already_decided');
  });

  it('cannot be decided after expiry', () => {
    expect(codeOf(() => decidePermission(pending(), 'allow', at(30)))).toBe('permission_expired');
  });

  it('times out only once expired, and then cannot be decided', () => {
    expect(codeOf(() => timeoutPermission(pending(), at(10)))).toBe('permission_not_expired');
    const timedOut = timeoutPermission(pending(), at(30));
    expect(timedOut).toMatchObject({ status: 'timeout', decidedAt: at(30) });
    expect(codeOf(() => decidePermission(timedOut, 'allow', at(31)))).toBe('already_decided');
  });
});

describe('limit policy', () => {
  const limits = { dailyBudgetUsd: 20, taskTimeoutMinutes: 60, stallMinutes: 10 };

  it('usageLeft is the remaining budget, floored at zero', () => {
    expect(usageLeft(0, limits)).toBe(20);
    expect(usageLeft(12.5, limits)).toBe(7.5);
    expect(usageLeft(20, limits)).toBe(0);
    expect(usageLeft(25, limits)).toBe(0);
  });

  it('canStartRun is false exactly when the budget is reached (LIM-04)', () => {
    expect(canStartRun(0, limits)).toEqual({ ok: true });
    expect(canStartRun(19.99, limits)).toEqual({ ok: true });
    expect(canStartRun(20, limits)).toEqual({ ok: false, reason: 'daily_budget_reached' });
    expect(canStartRun(30, limits)).toEqual({ ok: false, reason: 'daily_budget_reached' });
  });

  it('isTaskTimedOut compares active worker time with the limit (WRK-11)', () => {
    expect(isTaskTimedOut(0, limits)).toBe(false);
    expect(isTaskTimedOut(59 * 60_000, limits)).toBe(false);
    expect(isTaskTimedOut(60 * 60_000, limits)).toBe(true);
    expect(isTaskTimedOut(600 * 60_000, limits)).toBe(true);
  });

  it('isStalled fires at stallMinutes without events (DSP-09)', () => {
    expect(isStalled(T0, at(9), limits)).toBe(false);
    expect(isStalled(T0, at(10), limits)).toBe(true);
    expect(isStalled(at(5), at(10), limits)).toBe(false);
  });
});
