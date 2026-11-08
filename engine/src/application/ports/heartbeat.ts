/** Outbound liveness signal (ADR-0016). Rejects when the ping did not get through; the caller decides what to do. */
export interface Heartbeat {
  /** `ok` pings the check URL, `fail` pings its `/fail` address. */
  beat(outcome: 'ok' | 'fail'): Promise<void>;
}
