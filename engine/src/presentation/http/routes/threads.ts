import { PostMessageBodySchema } from '@jarvis/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Application } from '../../../application/index.js';
import { parse } from '../parse.js';

interface IdParams {
  id: string;
}

/** SLK-01, SLK-02, ADM-01: the chat's threads and the owner's messages. */
export function threadRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.get('/threads', () => app.getThreads.execute());

    http.get<{ Params: IdParams }>('/threads/:id', (request) =>
      app.getThread.execute(request.params.id),
    );

    http.post('/threads', async (request, reply) => {
      const { text } = parse(PostMessageBodySchema, request.body);
      const posted = await app.postOwnerMessage.execute({ text });
      const thread = await app.getThread.execute(posted.threadId);
      return reply.code(201).send(thread);
    });

    http.post<{ Params: IdParams }>('/threads/:id/messages', async (request, reply) => {
      const { text } = parse(PostMessageBodySchema, request.body);
      // A message for an unknown thread is a 404, not a foreign-key failure.
      await app.getThread.execute(request.params.id);
      await app.postOwnerMessage.execute({ threadId: request.params.id, text });
      return reply.code(204).send();
    });
  };
}
