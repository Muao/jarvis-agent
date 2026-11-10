import { UsageQuerySchema } from '@jarvis/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Application } from '../../../application/index.js';
import { parse } from '../parse.js';

/** What runs cost over a window, grouped, and the owner's "reset today's usage" (LIM-04). */
export function usageRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.get('/usage', (request) => app.getUsage.execute(parse(UsageQuerySchema, request.query)));
    http.post('/usage/reset', () => app.resetDailyUsage.execute());
  };
}
