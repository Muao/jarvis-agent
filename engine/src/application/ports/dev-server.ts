/**
 * The dev server the worker's UI check runs against (ADR-0014). The engine owns the process:
 * the command comes from `ui.devCommand`, never from a model, and every server holds a lease
 * that the engine ends by killing the process tree. One lease at a time, engine-wide.
 */
export interface DevServerLease {
  /** The task that holds the lease. */
  readonly taskId: string;
  /** `ui.baseUrl` — where the agent points the browser. */
  readonly baseUrl: string;
  /** When the engine kills the process tree unless the lease is renewed. */
  readonly expiresAt: string;
}

export type DevServerRefusal =
  /** `ui.enabled` is false. */
  | 'disabled'
  /** Another task holds the lease. */
  | 'busy'
  /** Something else already listens on `ui.baseUrl`. */
  | 'port_busy'
  /** The command started but `ui.readyPath` never answered in time. */
  | 'not_ready'
  /** The command exited before becoming ready. */
  | 'exited'
  /**
   * ADR-0018: the task checks a pull request whose head is a fork or whose author is not in
   * `allowlist.githubReviewers`, and the owner did not approve running its code. Refused by
   * `StartDevServer` before the manager is ever asked — no process was started.
   */
  | 'untrusted_head';

export interface DevServerStarted {
  readonly ok: true;
  readonly lease: DevServerLease;
}

export interface DevServerRefused {
  readonly ok: false;
  readonly reason: DevServerRefusal;
  /** One line for the agent: what happened, and the tail of the command's output when there is one. */
  readonly detail: string;
}

export type DevServerResult = DevServerStarted | DevServerRefused;

export interface DevServerManager {
  /**
   * Starts `ui.devCommand` in `cwd` and resolves once `ui.readyPath` answers with a non-5xx
   * status. Called again by the same task it renews the lease and returns the same `baseUrl`
   * without starting a second process; called by another task while a lease is live it refuses
   * with `busy` and leaves the running server alone.
   */
  start(taskId: string, cwd: string): Promise<DevServerResult>;
  /** Ends the lease of `taskId` and kills its process tree. A task without a lease is a no-op. */
  stop(taskId: string): Promise<void>;
  /** Ends whatever lease is live, whoever holds it. Used on run exit, stage change and shutdown. */
  stopAll(): Promise<void>;
  /** The live lease, or null. */
  current(): DevServerLease | null;
}
