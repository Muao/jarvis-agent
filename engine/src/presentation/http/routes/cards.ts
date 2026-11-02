import { AnswerMessageBodySchema, AnswerPermissionBodySchema } from '@jarvis/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Application } from '../../../application/index.js';
import { parse } from '../parse.js';

interface IdParams {
  id: string;
}

/** SLK-05, SLK-06: the one answer a decision, question or permission card takes. */
export function cardRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.post<{ Params: IdParams }>('/messages/:id/answer', async (request, reply) => {
      const answer = parse(AnswerMessageBodySchema, request.body);
      if ('decision' in answer) {
        await app.answerDecision.execute(request.params.id, answer);
      } else {
        await app.answerQuestion.execute(request.params.id, answer.text);
      }
      return reply.code(204).send();
    });

    http.post<{ Params: IdParams }>('/permissions/:id', async (request, reply) => {
      const { decision } = parse(AnswerPermissionBodySchema, request.body);
      await app.answerPermission.execute(request.params.id, decision);
      return reply.code(204).send();
    });
  };
}
