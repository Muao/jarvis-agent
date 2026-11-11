import type { FastifyInstance } from 'fastify';
import { ForbiddenError } from '../../application/index.js';

/** Header the web UI (and any script) sends on a mutating owner request (ADR-0028). */
export const OWNER_HEADER = 'x-jarvis-owner';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Run-token routes called by the MCP server; they carry `Authorization: Bearer`, not the owner header. */
const AGENT_PREFIX = '/api/agent/';

export interface OwnerGuardOptions {
  /** Origins besides the request's own host that may call the API, for example a remote dev UI. */
  readonly allowedOrigins?: readonly string[];
}

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

/**
 * The owner API has no login: the tailnet and loopback are the boundary. A page the worker's browser
 * opens (or the app under test) can still fire body-less cross-origin POSTs at it, so a mutating
 * request must (1) carry a custom header, which a cross-origin page cannot add without a preflight
 * the API never answers, and (2) if it carries an `Origin`, come from the same host or an allowed origin.
 */
export function registerOwnerGuard(http: FastifyInstance, options: OwnerGuardOptions = {}): void {
  const allowed = new Set(options.allowedOrigins ?? []);
  http.addHook('onRequest', async (request) => {
    if (!MUTATING.has(request.method)) return;
    const path = request.url.split('?')[0] ?? '';
    if (path.startsWith(AGENT_PREFIX)) return;
    if (request.headers[OWNER_HEADER] !== '1') {
      throw new ForbiddenError(
        'Mutating owner requests must carry the header "X-Jarvis-Owner: 1".',
      );
    }
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (allowed.has(origin) || hostOf(origin) === request.headers.host) return;
    throw new ForbiddenError('Cross-origin request refused.');
  });
}
