import { vi } from 'vitest';

type Reply = unknown | { status: number; body: unknown };

/** `"GET /api/overview"` → JSON body, or `{ status, body }` for a non-200. */
export type FakeRoutes = Record<string, Reply | (() => Reply)>;

function isStatusReply(reply: Reply): reply is { status: number; body: unknown } {
  return typeof reply === 'object' && reply !== null && 'status' in reply && 'body' in reply;
}

/** Stubs `fetch` with canned JSON per route; unknown routes answer 404 `not_found`. Returns the spy. */
export function stubFetch(routes: FakeRoutes) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input).split('?')[0];
    const entry = routes[`${method} ${path}`];
    if (entry === undefined) {
      return Response.json(
        { code: 'not_found', message: `No route ${method} ${path}` },
        { status: 404 },
      );
    }
    const reply = typeof entry === 'function' ? entry() : entry;
    return isStatusReply(reply)
      ? Response.json(reply.body, { status: reply.status })
      : Response.json(reply);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}
