import { describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_TIMEOUT_MS, HttpHeartbeat, type FetchFn } from './http-heartbeat.js';

const URL_WITH_TOKEN = 'https://hc-ping.example/ping/secret-token-123';

function fakeFetch(answer: { ok: boolean; status: number } | Error = { ok: true, status: 200 }) {
  const calls: { url: string; signal: AbortSignal }[] = [];
  const fn: FetchFn = (url, init) => {
    calls.push({ url, signal: init.signal });
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { fn, calls };
}

describe('HttpHeartbeat', () => {
  it('pings the base URL for ok and <url>/fail for fail', async () => {
    const { fn, calls } = fakeFetch();
    const heartbeat = new HttpHeartbeat(URL_WITH_TOKEN, fn);
    await heartbeat.beat('ok');
    await heartbeat.beat('fail');
    expect(calls.map((c) => c.url)).toEqual([URL_WITH_TOKEN, `${URL_WITH_TOKEN}/fail`]);
  });

  it('does not double a trailing slash', async () => {
    const { fn, calls } = fakeFetch();
    await new HttpHeartbeat(`${URL_WITH_TOKEN}/`, fn).beat('fail');
    expect(calls[0]?.url).toBe(`${URL_WITH_TOKEN}/fail`);
  });

  it('gives each request a timeout signal', async () => {
    const { fn, calls } = fakeFetch();
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await new HttpHeartbeat(URL_WITH_TOKEN, fn).beat('ok');
    expect(spy).toHaveBeenCalledWith(HEARTBEAT_TIMEOUT_MS);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    spy.mockRestore();
  });

  it('rejects on a non-2xx answer, without the URL', async () => {
    const heartbeat = new HttpHeartbeat(URL_WITH_TOKEN, fakeFetch({ ok: false, status: 502 }).fn);
    await expect(heartbeat.beat('ok')).rejects.toThrow('endpoint answered HTTP 502');
  });

  it('rejects when fetch rejects, and the error never quotes the URL', async () => {
    const boom = new TypeError(`fetch failed for ${URL_WITH_TOKEN}`, {
      cause: new Error(URL_WITH_TOKEN),
    });
    const heartbeat = new HttpHeartbeat(URL_WITH_TOKEN, fakeFetch(boom).fn);
    const error = await heartbeat.beat('ok').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe('request did not complete (TypeError)');
    expect(JSON.stringify(error) + String(error?.stack) + String(error?.cause)).not.toContain(
      'secret-token-123',
    );
  });
});
