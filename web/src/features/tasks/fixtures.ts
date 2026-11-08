import type { RunDto, TaskDetailDto, TaskDto } from '@jarvis/shared';

/** Test data for the Tasks screens. */
const AT = '2026-10-26T10:00:00.000Z';
const LATER = '2026-10-26T10:30:00.000Z';

export const task = (patch: Partial<TaskDto> = {}): TaskDto => ({
  id: 'T-12',
  threadId: 'th-1',
  title: 'Add the export page',
  stage: 'Implementing',
  waitingFor: '—',
  branch: 'jarvis/T-12',
  prNumber: null,
  prUrl: null,
  ci: null,
  runCount: 2,
  costUsd: 1.5,
  updatedAt: AT,
  ...patch,
});

export const run = (patch: Partial<RunDto> = {}): RunDto => ({
  id: 'run-1',
  sessionId: 'ses-1',
  taskId: 'T-12',
  role: 'worker',
  stage: 'Implementing',
  status: 'completed',
  startedAt: AT,
  endedAt: LATER,
  usage: { input: 12_000, output: 3_400, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.75,
  turns: 10,
  maxTurns: 40,
  stopReason: null,
  modelUsage: {},
  exitCode: 0,
  error: null,
  ...patch,
});

export const taskDetail = (patch: Partial<TaskDetailDto> = {}): TaskDetailDto => ({
  ...task({ prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', ci: 'failed' }),
  startedAt: AT,
  reason: null,
  counters: {
    checks: { used: 0, max: 3 },
    ciFixes: { used: 1, max: 2 },
    reviews: { used: 0, max: 3 },
  },
  stages: [
    { stage: 'Context', enteredAt: AT, exitedAt: LATER, reason: null },
    { stage: 'Implementing', enteredAt: LATER, exitedAt: '2026-10-26T11:00:00.000Z', reason: null },
    {
      stage: 'PR Open',
      enteredAt: '2026-10-26T11:00:00.000Z',
      exitedAt: '2026-10-26T11:10:00.000Z',
      reason: null,
    },
    {
      stage: 'Fixing',
      enteredAt: '2026-10-26T11:10:00.000Z',
      exitedAt: '2026-10-26T11:20:00.000Z',
      reason: null,
    },
    { stage: 'PR Open', enteredAt: '2026-10-26T11:20:00.000Z', exitedAt: null, reason: null },
  ],
  pullRequest: {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    headSha: 'abcdef1234567890',
    checks: [
      { name: 'lint', status: 'passed', durationMs: 42_000, url: 'https://ci.example/lint' },
      { name: 'unit tests', status: 'failed', durationMs: 125_000, url: 'https://ci.example/unit' },
    ],
    earlierChecks: [{ name: 'old build', status: 'failed', durationMs: 9_000, url: null }],
    review: 'changes_requested',
    comments: [
      { id: 'c1', author: 'maria', body: 'Please rename `foo`.', handling: 'handled' },
      { id: 'c2', author: 'dependabot', body: 'Bump all the things', handling: 'ignored' },
    ],
    lastCheckedAt: AT,
  },
  runs: [
    run(),
    run({ id: 'run-2', status: 'limit_reached', turns: 40, startedAt: LATER, endedAt: null }),
  ],
  journal: [
    { id: 'j2', at: LATER, type: 'owner_action', text: 'Retried the stage', by: 'owner' },
    { id: 'j1', at: AT, type: 'stage', text: 'Entered Context', by: 'system' },
  ],
  artifacts: [
    { name: 'context.md', exists: true },
    { name: 'spec.md', exists: true },
    { name: 'plan.md', exists: false },
    { name: 'tasks.md', exists: false },
    { name: 'result.md', exists: false },
  ],
  workerSessionId: 'ses-1',
  ...patch,
});
