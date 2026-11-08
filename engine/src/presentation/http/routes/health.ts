import type { FastifyPluginAsync } from 'fastify';
import type { Application } from '../../../application/index.js';

/** For systemd and monitoring: 200 while the engine can serve (`ok`, `degraded`), 503 when it cannot. */
export function healthRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.get('/health', async (_request, reply) => {
      const health = await app.getHealth.execute();
      return reply.code(health.status === 'failed' ? 503 : 200).send(health);
    });
  };
}
