import type { Role, RunEvent, TaskStage, TokenUsage, UsageGroupBy } from '@jarvis/shared';
import type { IsoTime, Run } from '../../domain/index.js';
import type { RunEventBody } from './agent-runner.js';

/** How many runs a task had and what they cost (Tasks list). */
export interface RunTotals {
  readonly runCount: number;
  readonly costUsd: number;
  /** Input, output, cache writes and cache reads of every run of the task, together. */
  readonly tokens: number;
}

/** Estimated cost since a point in time, split for the Config screen. Every role is present. */
export interface UsageBreakdown {
  readonly byRole: Readonly<Record<Role, number>>;
  /** Most expensive first; runs without a task are not listed. */
  readonly byTask: readonly { readonly taskId: string; readonly costUsd: number }[];
}

/** The half-open window `[from, to)` on `started_at`. */
export interface UsageWindow {
  readonly from: IsoTime;
  readonly to: IsoTime;
}

/** What a set of runs consumed. */
export interface UsageFigures {
  readonly runs: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly tokens: TokenUsage;
  /** Runs per ending; a run still going is counted under `running`. */
  readonly stopReasons: Readonly<Record<string, number>>;
  /** Finished runs only. */
  readonly durationMs: number;
}

/** One group of a usage report. `session` rows carry role/thread/task, `task` rows the stage. */
export interface UsageGroup extends UsageFigures {
  readonly key: string;
  readonly role?: Role;
  readonly threadId?: string;
  readonly taskId?: string | null;
  readonly stage?: TaskStage;
}

export interface UsageAggregate {
  readonly rows: readonly UsageGroup[];
  /** Over every run in the window, whatever the grouping. */
  readonly total: UsageFigures;
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
  /**
   * Tokens of the runs started at or after `since`: input, output, cache writes and cache reads
   * together (usage today, LIM-04).
   */
  tokensSince(since: IsoTime): Promise<number>;
  /** The same cost split by role and task. */
  usageSince(since: IsoTime): Promise<UsageBreakdown>;
  /**
   * Runs started in the window, aggregated in the database by UTC day of `started_at`, session, task or
   * model (unnesting `model_usage`). Day rows are oldest first, the others most expensive first.
   */
  usageReport(window: UsageWindow, groupBy: UsageGroupBy): Promise<UsageAggregate>;
  /** The newest event of the run, if it produced any (stall detection, DSP-09). */
  lastEvent(runId: string): Promise<RunEvent | null>;
  /** The newest events of the run whose kind is one of `kinds`, newest first, at most `limit`. */
  lastEventsOfKinds(
    runId: string,
    kinds: readonly RunEvent['kind'][],
    limit: number,
  ): Promise<readonly RunEvent[]>;
  /** Events of the run with `seq` greater than `afterSeq` (all when omitted), in `seq` order. */
  events(runId: string, afterSeq?: number): Promise<readonly RunEvent[]>;
  /** Store an event under the run's next `seq` (0, 1, 2, ...) and return it. */
  appendEvent(runId: string, body: RunEventBody, at: IsoTime): Promise<RunEvent>;
}
