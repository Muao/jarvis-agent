import type { FastifyInstance } from 'fastify';

/**
 * Test helper: makes `http.inject` send `X-Jarvis-Owner: 1` the way the web UI does, so route tests
 * exercise the routes and not the owner guard (owner-guard.test.ts covers that).
 */
export function asOwner(http: FastifyInstance): FastifyInstance {
  const inject = http.inject.bind(http) as (options: object) => unknown;
  (http as unknown as { inject: unknown }).inject = (options: { headers?: object }) =>
    inject({ ...options, headers: { 'x-jarvis-owner': '1', ...options.headers } });
  return http;
}
