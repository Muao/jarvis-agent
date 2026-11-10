import type { OverviewDto, RunEvent, ThreadDto, UsageDto } from '@jarvis/shared';

const AT = '2026-10-26T10:00:00.000Z';

export const usage = (patch: Partial<UsageDto> = {}): UsageDto => ({
  todayUsd: 3.2,
  budgetUsd: 20,
  resetsAt: '2026-10-27T00:00:00.000Z',
  paused: false,
  ...patch,
});

export const overview = (patch: Partial<OverviewDto> = {}): OverviewDto => ({
  usage: usage(),
  dispatcher: { status: 'idle', action: null, runningSince: null, sessionId: null },
  workers: [{ state: 'free' }],
  queue: [],
  watching: [],
  waitingForOwner: 0,
  prsOpen: 0,
  events: [],
  ...patch,
});

export const thread = (patch: Partial<ThreadDto> = {}): ThreadDto => ({
  id: 'th-1',
  title: 'Add a page',
  taskId: null,
  stage: null,
  working: false,
  held: false,
  model: null,
  prNumber: null,
  prUrl: null,
  waitingForOwner: false,
  lastActivityAt: AT,
  ...patch,
});

export const textEvent = (seq: number, runId = 'run-1'): RunEvent => ({
  seq,
  runId,
  at: AT,
  kind: 'text',
  payload: { text: `line ${seq}` },
});
