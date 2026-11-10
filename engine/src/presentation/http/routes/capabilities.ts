import {
  CapabilityKindSchema,
  OwnerAgentInputSchema,
  OwnerCapabilityParamsSchema,
  OwnerSkillInputSchema,
  type CapabilityKind,
} from '@jarvis/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { Application } from '../../../application/index.js';
import { parse } from '../parse.js';

interface OwnerParams {
  kind: string;
  name: string;
}

function target(params: OwnerParams): { kind: CapabilityKind; name: string } {
  return {
    kind: parse(CapabilityKindSchema, params.kind),
    name: parse(OwnerCapabilityParamsSchema, { name: params.name }).name,
  };
}

/**
 * ADR-0025: what runs can use, and the owner's own skills and subagents. These are owner routes
 * for the web UI. There is deliberately no `/agent/...` route and no MCP tool for the writes: a
 * prompt injection that reaches an agent must not be able to rewrite the agent's instructions.
 */
export function capabilityRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.get('/capabilities', () => app.listCapabilities.execute());

    http.get<{ Params: OwnerParams }>('/capabilities/owner/:kind/:name', (request) => {
      const { kind, name } = target(request.params);
      return app.getOwnerCapability.execute(kind, name);
    });

    http.put<{ Params: OwnerParams }>('/capabilities/owner/:kind/:name', async (request, reply) => {
      const { kind, name } = target(request.params);
      const input = parse(
        kind === 'skills' ? OwnerSkillInputSchema : OwnerAgentInputSchema,
        request.body,
      );
      const { created } = await app.saveOwnerCapability.execute(kind, name, input);
      const doc = await app.getOwnerCapability.execute(kind, name);
      return reply.code(created ? 201 : 200).send(doc);
    });

    http.delete<{ Params: OwnerParams }>(
      '/capabilities/owner/:kind/:name',
      async (request, reply) => {
        const { kind, name } = target(request.params);
        await app.deleteOwnerCapability.execute(kind, name);
        return reply.code(204).send();
      },
    );
  };
}
