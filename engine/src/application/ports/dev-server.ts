import type { EnvironmentPlan } from '@jarvis/shared';

/**
 * The environment the worker's UI check runs against (ADR-0014, ADR-0026). The worker composes an
 * environment plan from the target repository; the engine runs it in disposable containers and
 * holds a lease that it ends by removing them. One lease at a time, engine-wide.
 */
export interface DevServerLease {
  /** The task that holds the lease. */
  readonly taskId: string;
  /** Where the agent points the browser: the plan's `app.port` on the host's loopback. */
  readonly baseUrl: string;
  /** Every origin of this environment the browser may reach: the app and the plan's `extraPorts`. */
  readonly origins: readonly string[];
  /** When the engine removes the containers unless the lease is renewed. */
  readonly expiresAt: string;
}

export type DevServerRefusal =
  /** `ui.enabled` is false. */
  | 'disabled'
  /** Another task holds the lease. */
  | 'busy'
  /** The Docker daemon does not answer; nothing can run. */
  | 'docker_unavailable'
  /** The plan carries a literal credential or refers to a variable it does not define. */
  | 'invalid_plan'
  /** A port the plan publishes is already taken on the host. */
  | 'port_busy'
  /** An image could not be pulled, or a `prepare` command or a service failed. */
  | 'step_failed'
  /** Everything started but a service's port or the app's page never answered in time. */
  | 'not_ready'
  /** The app's command exited before its page answered. */
  | 'exited'
  /** The run used up `ui.maxStartAttempts`. */
  | 'attempts_exhausted'
  /**
   * ADR-0018: the task checks a pull request whose head is a fork or whose author is not in
   * `allowlist.githubReviewers`, and the owner did not approve running its code. Refused by
   * `StartDevServer` before the manager is ever asked — nothing was started.
   */
  | 'untrusted_head';

export interface DevServerStarted {
  readonly ok: true;
  readonly lease: DevServerLease;
  /**
   * Generated values the plan marked `reveal`, for the worker to hand to the browser (a test
   * login). For the caller only: kept out of the task journal and the logs.
   */
  readonly revealed?: Readonly<Record<string, string>>;
}

export interface DevServerRefused {
  readonly ok: false;
  readonly reason: DevServerRefusal;
  /** For the agent: what happened, and the tail of the failing step's output when there is one. */
  readonly detail: string;
  /** Which step of the plan failed: `image node:22`, `prepare[0]`, `services.api`, `app`. */
  readonly step?: string;
  readonly exitCode?: number | null;
}

export type DevServerResult = DevServerStarted | DevServerRefused;

export interface DevServerManager {
  /**
   * Brings `plan` up for the sources in `cwd` and resolves once the app's page answers with a
   * non-5xx status. Called again by the same task with the same plan it renews the lease; with a
   * different plan it replaces the running environment. Called by another task while a lease is
   * live it refuses with `busy` and leaves the running environment alone.
   */
  start(taskId: string, cwd: string, plan: EnvironmentPlan): Promise<DevServerResult>;
  /** Ends the lease of `taskId` and removes its containers. A task without a lease is a no-op. */
  stop(taskId: string): Promise<void>;
  /** Ends whatever lease is live, whoever holds it. Used on run exit, stage change and shutdown. */
  stopAll(): Promise<void>;
  /** The live lease, or null. */
  current(): DevServerLease | null;
}
