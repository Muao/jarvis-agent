import { ArtifactNameSchema } from '@jarvis/shared';
import type { FastifyPluginAsync } from 'fastify';
import { DomainError, type Application } from '../../../application/index.js';
import { parse } from '../parse.js';

interface TaskParams {
  id: string;
}

/** ADM-01, ADM-02, ADM-06: tasks, their artifacts, and the owner's task commands. */
export function taskRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.get('/tasks', () => app.getTasks.execute());

    http.get<{ Params: TaskParams }>('/tasks/:id', (request) =>
      app.getTask.execute(request.params.id),
    );

    http.get<{ Params: TaskParams & { name: string } }>('/tasks/:id/artifacts/:name', (request) => {
      const name = parse(ArtifactNameSchema, request.params.name);
      return app.getArtifact.execute(request.params.id, name);
    });

    http.post<{ Params: TaskParams }>('/tasks/:id/cancel', async (request, reply) => {
      await app.cancelTask.execute({ taskId: request.params.id });
      return reply.code(204).send();
    });

    http.post<{ Params: TaskParams }>('/tasks/:id/retry', async (request, reply) => {
      await app.retryStage.execute(request.params.id);
      return reply.code(204).send();
    });

    // Stops the task's live worker process; the task itself stays as it is.
    http.post<{ Params: TaskParams }>('/tasks/:id/stop', async (request, reply) => {
      const task = await app.getTask.execute(request.params.id);
      const live = task.runs.find((run) => run.role === 'worker' && run.status === 'running');
      if (live === undefined) {
        throw new DomainError('run_not_running', `Task ${task.id} has no running worker`);
      }
      await app.stopRun.execute(live.id);
      return reply.code(204).send();
    });
  };
}
