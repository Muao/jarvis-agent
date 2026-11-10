import { toolInputSchemas, toolsByRole, type ToolName } from '@jarvis/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  ForbiddenError,
  NotFoundError,
  type Application,
  type RunIdentity,
} from '../../../application/index.js';
import { UnauthorizedError } from '../errors.js';
import { parse } from '../parse.js';
import { RETIRED_TOOLS, toolCalls } from './agent-tools.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/** The run behind `Authorization: Bearer <run token>`; no header is 401, an unknown or finished run is 403. */
function identityOf(app: Application, request: FastifyRequest): RunIdentity {
  const match = BEARER.exec(request.headers.authorization ?? '');
  if (match?.[1] === undefined) throw new UnauthorizedError('A run token is required.');
  return app.resolveRunIdentity.execute(match[1]);
}

const isToolName = (name: string): name is ToolName => Object.hasOwn(toolInputSchemas, name);

function requireTool(identity: RunIdentity, tool: ToolName): void {
  if (!(toolsByRole[identity.role] as readonly ToolName[]).includes(tool)) {
    throw new ForbiddenError(`The ${identity.role} has no tool "${tool}".`);
  }
}

/** Internal routes the Jarvis MCP server calls on behalf of a run (ADR-0004). */
export function agentRoutes(app: Application): FastifyPluginAsync {
  return async (http) => {
    http.post<{ Params: { tool: string } }>('/agent/tools/:tool', async (request) => {
      const identity = identityOf(app, request);
      const { tool } = request.params;
      if (!isToolName(tool)) throw new NotFoundError('tool', tool);
      const call = toolCalls[tool];
      if (call === undefined) throw new NotFoundError('tool', tool);
      // A worker session from before ADR-0022 still calls the retired tools; it gets the redirect.
      if (!(identity.role === 'worker' && RETIRED_TOOLS.includes(tool))) {
        requireTool(identity, tool);
      }
      return call(app, identity, request.body ?? {});
    });

    // Long request: it answers when the owner decides or the request expires, so no request timeout applies.
    http.post('/agent/permissions', async (request) => {
      const identity = identityOf(app, request);
      requireTool(identity, 'approve');
      const input = parse(toolInputSchemas.approve, request.body);
      const permissionId = await app.requestPermission.execute(identity, input);
      return app.awaitPermission.execute(permissionId);
    });
  };
}
