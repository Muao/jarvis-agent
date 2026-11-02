import type { Role, RunEvent } from '@jarvis/shared';
import type { IsoTime, Run } from '../../domain/index.js';
import type { RunEventBody } from './agent-runner.js';

/** How many runs a task had and what they cost (Tasks list). */
export interface RunTotals {
  readonly runCount: number;
  readonly costUsd: number;
}

/** Estimated cost since a point in time, split for the Config screen. Every role is present. */
export interface UsageBreakdown {
  readonly byRole: Readonly<Record<Role, number>>;
  /** Most expensive first; runs without a task are not listed. */
  readonly byTask: readonly { readonly taskId: string; readonly costUsd: number }[];
}

export interface RunRepository {
  get(id: string): Promise<Run | null>;
  save(run: Run): Promise<void>;
  /** A dispatcher run is `running` in this thread (decides `dispatcher_queued`, see `routeOwnerMessage`). */
  dispatcherBusy(threadId: string): Promise<boolean>;
  /** Every run whose status is `running`. */
  listRunning(): Promise<readonly Run[]>;
  /** Runs of one task, oldest first. */
  listByTask(taskId: string): Promise<readonly Run[]>;
  /** Runs of one session, oldest first. */
  listBySession(sessionId: string): Promise<readonly Run[]>;
  /** The most recently started run of a role, if any. */
  latestOfRole(role: Role): Promise<Run | null>;
  /** Run count and cost for every task that had a run. */
  totalsByTask(): Promise<ReadonlyMap<string, RunTotals>>;
  /** Estimated cost of the runs started at or after `since` (usage today, LIM-04). */
  costSince(since: IsoTime): Promise<number>;
  /** The same cost split by role and task. */
  usageSince(since: IsoTime): Promise<UsageBreakdown>;
  /** The newest event of the run, if it produced any (stall detection, DSP-09). */
  lastEvent(runId: string): Promise<RunEvent | null>;
  /** Events of the run with `seq` greater than `afterSeq` (all when omitted), in `seq` order. */
  events(runId: string, afterSeq?: number): Promise<readonly RunEvent[]>;
  /** Store an event under the run's next `seq` (0, 1, 2, ...) and return it. */
  appendEvent(runId: string, body: RunEventBody, at: IsoTime): Promise<RunEvent>;
}
