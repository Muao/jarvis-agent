import type { Heartbeat } from '../../application/ports/heartbeat.js';

/** A hanging endpoint must not pile up ticks: the interval is 60 s, the request gets 5 s. */
export const HEARTBEAT_TIMEOUT_MS = 5000;

export type FetchFn = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * GET to a healthchecks.io style URL: the URL itself means "alive", the URL plus `/fail` means "failed".
 * The URL carries a token, so no error thrown from here ever contains it.
 */
export class HttpHeartbeat implements Heartbeat {
  private readonly okUrl: string;
  private readonly failUrl: string;

  constructor(
    url: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.okUrl = url;
    // `/fail` goes on the path: a query string (`?create=1`) and a fragment stay where they are.
    const failUrl = new URL(url);
    failUrl.pathname = `${failUrl.pathname.replace(/\/+$/, '')}/fail`;
    this.failUrl = failUrl.toString();
  }

  async beat(outcome: 'ok' | 'fail'): Promise<void> {
    const url = outcome === 'ok' ? this.okUrl : this.failUrl;
    let status: number;
    try {
      const response = await this.fetchFn(url, {
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      });
      if (response.ok) return;
      status = response.status;
    } catch (error) {
      // Only the error's name: a message or cause may quote the URL.
      throw new Error(
        `request did not complete (${error instanceof Error ? error.name : 'error'})`,
      );
    }
    throw new Error(`endpoint answered HTTP ${status}`);
  }
}
