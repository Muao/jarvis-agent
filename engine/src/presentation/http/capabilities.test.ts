import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CapabilitiesSchema,
  OwnerCapabilityDocSchema,
  toolInputSchemas,
  toolsByRole,
} from '@jarvis/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../../application/testing/index.js';
import { SseHub } from '../../infrastructure/sse/sse-hub.js';
import { buildServer } from './server.js';

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function start(): { app: TestApp; http: FastifyInstance } {
  const app = buildTestApp();
  const http = buildServer(app, { stream: new SseHub() });
  servers.push(http);
  return { app, http };
}

const URL = '/api/capabilities/owner';

describe('GET /api/capabilities', () => {
  it('lists skills, subagents and MCP servers from every source', async () => {
    const { http, app } = start();
    await app.ownerPlugin.put('skills', 'mine', { description: 'Mine', body: '#' });

    const res = await http.inject({ method: 'GET', url: '/api/capabilities' });

    expect(res.statusCode).toBe(200);
    const body = CapabilitiesSchema.parse(res.json());
    expect(body.skills.map((s) => [s.name, s.source, s.editable])).toEqual([
      ['sdd-flow', 'builtin', false],
      ['mine', 'owner', true],
    ]);
    expect(body.agents).toHaveLength(1);
  });
});

describe('owner skills and subagents', () => {
  it('PUT creates (201), replaces (200), GET reads it back, DELETE removes it (204, then 404)', async () => {
    const { http } = start();
    const payload = { description: 'Does x', body: '# Steps' };

    const created = await http.inject({ method: 'PUT', url: `${URL}/skills/my-skill`, payload });
    expect(created.statusCode).toBe(201);
    expect(OwnerCapabilityDocSchema.parse(created.json())).toMatchObject({
      name: 'my-skill',
      description: 'Does x',
    });

    const replaced = await http.inject({
      method: 'PUT',
      url: `${URL}/skills/my-skill`,
      payload: { ...payload, description: 'Does y' },
    });
    expect(replaced.statusCode).toBe(200);

    const read = await http.inject({ method: 'GET', url: `${URL}/skills/my-skill` });
    expect(read.json()).toMatchObject({ description: 'Does y' });

    expect(
      (await http.inject({ method: 'DELETE', url: `${URL}/skills/my-skill` })).statusCode,
    ).toBe(204);
    expect(
      (await http.inject({ method: 'DELETE', url: `${URL}/skills/my-skill` })).statusCode,
    ).toBe(404);
    expect((await http.inject({ method: 'GET', url: `${URL}/skills/my-skill` })).statusCode).toBe(
      404,
    );
  });

  it('accepts model and tools for a subagent only', async () => {
    const { http } = start();
    const agent = { description: 'd', body: 'b', model: 'opus', tools: ['Read'] };

    expect(
      (await http.inject({ method: 'PUT', url: `${URL}/agents/helper`, payload: agent }))
        .statusCode,
    ).toBe(201);
    expect(
      (await http.inject({ method: 'PUT', url: `${URL}/skills/helper`, payload: agent }))
        .statusCode,
    ).toBe(400);
  });

  it.each([
    ['a bad name', 'skills', 'Bad_Name', { description: 'd', body: '' }],
    ['a path-like name', 'skills', '..%2Fx', { description: 'd', body: '' }],
    ['an empty description', 'skills', 'ok', { description: '', body: '' }],
    ['a long description', 'skills', 'ok', { description: 'x'.repeat(1025), body: '' }],
    ['a huge body', 'skills', 'ok', { description: 'd', body: 'x'.repeat(64 * 1024 + 1) }],
    ['an unknown model', 'agents', 'ok', { description: 'd', body: '', model: 'gpt-4' }],
    ['an empty tool', 'agents', 'ok', { description: 'd', body: '', tools: [''] }],
    ['an unknown kind', 'plugins', 'ok', { description: 'd', body: '' }],
  ])('rejects %s with 400 and writes nothing', async (_label, kind, name, payload) => {
    const { http, app } = start();

    const res = await http.inject({ method: 'PUT', url: `${URL}/${kind}/${name}`, payload });

    expect(res.statusCode).toBe(400);
    expect(app.ownerPlugin.docs.size).toBe(0);
  });

  it('rejects the name of a built-in with a clear invalid_input error', async () => {
    const { http, app } = start();

    const skill = await http.inject({
      method: 'PUT',
      url: `${URL}/skills/sdd-flow`,
      payload: { description: 'd', body: '' },
    });
    const agent = await http.inject({
      method: 'PUT',
      url: `${URL}/agents/reviewer`,
      payload: { description: 'd', body: '' },
    });

    expect(skill.statusCode).toBe(400);
    expect(skill.json<{ code: string }>().code).toBe('invalid_input');
    expect(skill.json<{ message: string }>().message).toContain('built-in skill');
    expect(agent.statusCode).toBe(400);
    expect(agent.json<{ message: string }>().message).toContain('built-in subagent');
    expect(app.ownerPlugin.docs.size).toBe(0);
  });

  it('allows a skill to share its name with a built-in subagent (different namespaces)', async () => {
    const { http } = start();
    const res = await http.inject({
      method: 'PUT',
      url: `${URL}/skills/reviewer`,
      payload: { description: 'd', body: '' },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ADR-0025, and the same boundary as `FORBIDDEN_PATHS` for `ui.env`: the owner's skills and
// subagents are the agent's own instructions, so a prompt injection that reaches an agent must not
// be able to write them. They are written only by the owner's HTTP API, which no agent tool calls.
describe('no agent tool can write the owner plugin', () => {
  const ENGINE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  it('has no tool for it, for any role', () => {
    const tools = Object.keys(toolInputSchemas);
    expect(tools.filter((t) => /capabilit|plugin|skill|subagent|agent_def/i.test(t))).toEqual([]);
    for (const role of Object.keys(toolsByRole) as (keyof typeof toolsByRole)[]) {
      expect(toolsByRole[role].filter((t) => /capabilit|plugin|skill/i.test(t))).toEqual([]);
    }
  });

  it('exposes no capability route on the agent-facing endpoints', async () => {
    const { http } = start();
    for (const tool of ['save_owner_capability', 'put_skill', 'write_skill', 'capabilities']) {
      const res = await http.inject({
        method: 'POST',
        url: `/api/agent/tools/${tool}`,
        payload: {},
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it('is not referenced anywhere in the MCP server or the agent routes', () => {
    const files = [
      ...readdirSync(join(ENGINE_SRC, 'presentation', 'mcp')).map((f) =>
        join(ENGINE_SRC, 'presentation', 'mcp', f),
      ),
      join(ENGINE_SRC, 'presentation', 'http', 'routes', 'agent.ts'),
      join(ENGINE_SRC, 'presentation', 'http', 'routes', 'agent-tools.ts'),
    ].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /ownerPlugin|OwnerCapability|capabilities|plugin-backups/,
      );
    }
  });
});
