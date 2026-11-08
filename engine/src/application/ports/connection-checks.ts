import type { ConnectionId } from '@jarvis/shared';

/** The outcome of probing one connection. `details` never carries a token (SEC-04). */
export interface ConnectionOutcome {
  readonly status: 'ok' | 'warning' | 'failed' | 'not_configured' | 'disabled';
  readonly summary: string;
  /** Claude only: logged in with the subscription (`true`) or another way (`false`); absent or `null` when unknown. */
  readonly subscription?: boolean | null;
  /** Claude only: the login has expired, so a run cannot start. A failed or slow probe never sets this. */
  readonly loginExpired?: boolean;
  readonly details: readonly { readonly label: string; readonly value: string }[];
}

export interface ConnectionChecks {
  /** The environment would make `claude` bill the API instead of the subscription (SEC-05). */
  billingEnvDetected(): boolean;
  /** Probe one connection. Never rejects: a failing or slow probe is reported as `failed` with the reason. */
  check(id: ConnectionId): Promise<ConnectionOutcome>;
  /** The outcome of the last `check(id)`, or null before the first one. Never probes. */
  last(id: ConnectionId): ConnectionOutcome | null;
}
