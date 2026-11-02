import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Application } from '../../application/index.js';
import { registerErrorHandling } from './errors.js';
import { agentRoutes } from './routes/agent.js';
import { cardRoutes } from './routes/cards.js';
import { sessionRoutes } from './routes/sessions.js';
import { HEARTBEAT_MS, streamRoutes, type StreamSource } from './routes/stream.js';
import { statusRoutes } from './routes/status.js';
import { taskRoutes } from './routes/tasks.js';
import { threadRoutes } from './routes/threads.js';

/** The API is bound to loopback only (ADM-07); `container.ts` passes this to `listen`. */
export const LISTEN_HOST = '127.0.0.1';

export interface ServerOptions {
  readonly stream: StreamSource;
  /** Masks secrets in 500 messages (SEC-04). */
  readonly redact?: (text: string) => string;
  readonly logger?: FastifyServerOptions['logger'];
  /** Interval of `: ping` comments on the stream. */
  readonly heartbeatMs?: number;
}

/**
 * The Fastify instance for the engine API under `/api`: one error mapper, routes per resource.
 * Handlers only validate input with the shared schemas and call one use case.
 */
export function buildServer(app: Application, options: ServerOptions): FastifyInstance {
  const http = Fastify({
    logger: options.logger ?? false,
    // The permission long-poll can last `limits.permissionTimeoutMinutes`; never cut it from here.
    requestTimeout: 0,
    connectionTimeout: 0,
  });
  registerErrorHandling(http, options.redact ?? ((text) => text));

  const routes = [
    threadRoutes(app),
    cardRoutes(app),
    taskRoutes(app),
    sessionRoutes(app),
    statusRoutes(app),
    streamRoutes(options.stream, options.heartbeatMs ?? HEARTBEAT_MS),
    agentRoutes(app),
  ];
  for (const route of routes) void http.register(route, { prefix: '/api' });
  return http;
}
