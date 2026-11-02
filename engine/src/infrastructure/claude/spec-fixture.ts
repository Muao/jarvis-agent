import type { RunSpec } from '../../application/index.js';

/** A valid worker `RunSpec` for tests. */
export const specOf = (overrides: Partial<RunSpec> = {}): RunSpec => ({
  runId: 'R-1',
  role: 'worker',
  cwd: '/home/worktrees/T-1',
  firstMessage: 'hello',
  model: 'sonnet',
  maxTurns: 60,
  maxBudgetUsd: 3,
  runToken: 'token-1',
  keepStdinOpen: true,
  threadId: 'th-1',
  ...overrides,
});
