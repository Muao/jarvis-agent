import { UsageQuerySchema } from '@jarvis/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Application } from '../../../application/index.js';
import { parse } from '../parse.js';

/** What runs cost over a window, grouped. Read-only. */
export function usageRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.get('/usage', (request) => app.getUsage.execute(parse(UsageQuerySchema, request.query)));
  };
}
