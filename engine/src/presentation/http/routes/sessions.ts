import { RunEventsQuerySchema, SendSessionMessageBodySchema } from '@jarvis/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Application } from '../../../application/index.js';
import { parse } from '../parse.js';

interface IdParams {
  id: string;
}

/** ADM-03, ADM-04, ADM-06: the session console. */
export function sessionRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.get<{ Params: IdParams }>('/sessions/:id', (request) =>
      app.getSession.execute(request.params.id),
    );

    http.get<{ Params: IdParams }>('/runs/:id/events', (request) => {
      const { afterSeq } = parse(RunEventsQuerySchema, request.query);
      return app.getRunEvents.execute(request.params.id, afterSeq);
    });

    // Stops one running process, whatever its role (dispatcher included); 409 `run_not_running` otherwise.
    http.post<{ Params: IdParams }>('/runs/:id/stop', async (request, reply) => {
      await app.stopRun.execute(request.params.id);
      return reply.code(204).send();
    });

    http.post<{ Params: IdParams }>('/sessions/:id/messages', async (request) => {
      const { text } = parse(SendSessionMessageBodySchema, request.body);
      const delivery = await app.sendToSession.execute(request.params.id, text);
      return { delivery };
    });
  };
}
