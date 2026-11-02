import type { FastifyPluginAsync } from 'fastify';
import type { Application } from '../../../application/index.js';

/** ADM-05, ADM-08: overview, configuration and connections. Read-only. */
export function statusRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.get('/overview', () => app.getOverview.execute());
    http.get('/config', () => app.getConfig.execute());
    http.get('/connections', () => app.getConnections.execute());
  };
}
