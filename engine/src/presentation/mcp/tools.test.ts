import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApproveResultSchema, toolInputSchemas, toolsByRole, type Role } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './api-client.js';
import { readMcpEnv } from './env.js';
import { createJarvisMcpServer } from './server.js';

const TOKEN = 'run-token-123';
const URL_BASE = 'http://127.0.0.1:4000';
const IDENTITY_FIELDS = ['run', 'runId', 'role', 'thread', 'threadId', 'taskId', 'token', 'owner'];

function fakeTransport(respond: (req: HttpRequest) => HttpResponse | Error) {
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = async (req) => {
    calls.push(req);
    const out = respond(req);
    if (out instanceof Error) throw out;
    return out;
  };
  return { calls, transport };
}

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  body: JSON.stringify(body),
});

async function connect(role: Role, transport: HttpTransport) {
  const api = createApiClient({ baseUrl: URL_BASE, runToken: TOKEN, transport });
  const server = createJarvisMcpServer({ role, api });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  return content[0]?.text ?? '';
};

describe.each(['dispatcher', 'worker'] as const)('Jarvis MCP server, %s', (role) => {
  it('registers exactly the tools of the role', async () => {
    // contract: ADR-0004 role-scoped tool set
    const { transport } = fakeTransport(() => json(200, {}));
    const client = await connect(role, transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...toolsByRole[role]].sort());
    for (const tool of tools) expect(tool.description?.length).toBeGreaterThan(20);
  });

  it('exposes no identity field in any input schema', async () => {
    // contract: identity comes from the run token, never from arguments (ADR-0004)
    const { transport } = fakeTransport(() => json(200, {}));
    const client = await connect(role, transport);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      expect(
        props.filter((p) => IDENTITY_FIELDS.includes(p)),
        tool.name,
      ).toEqual([]);
    }
  });
});

describe('Jarvis MCP server: tool calls', () => {
  it('posts to the tool endpoint with the bearer token and returns the JSON as text', async () => {
    const { calls, transport } = fakeTransport(() => json(200, { id: 'T-1', title: 'Fix' }));
    const client = await connect('dispatcher', transport);

    const result = await client.callTool({
      name: 'create_task',
      arguments: { title: 'Fix', description: 'Fix the bug' },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ id: 'T-1', title: 'Fix' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${URL_BASE}/api/agent/tools/create_task`);
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ title: 'Fix', description: 'Fix the bug' });
  });

  it('calls a worker tool at its own endpoint', async () => {
    const { calls, transport } = fakeTransport(() => json(200, { ok: true }));
    const client = await connect('worker', transport);
    await client.callTool({ name: 'report_stage', arguments: { stage: 'Verifying' } });
    expect(calls[0]?.url).toBe(`${URL_BASE}/api/agent/tools/report_stage`);
  });

  it('rejects arguments that do not match the shared schema without calling the engine', async () => {
    const { calls, transport } = fakeTransport(() => json(200, {}));
    const client = await connect('worker', transport);
    const result = await client.callTool({
      name: 'log_note',
      arguments: { text: 'hi', runId: 'forged' },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('turns an engine error into isError with the engine message', async () => {
    const { transport } = fakeTransport(() =>
      json(403, { code: 'forbidden', message: 'The worker has no tool "reply".' }),
    );
    const client = await connect('worker', transport);
    const result = await client.callTool({ name: 'log_note', arguments: { text: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The worker has no tool "reply".');
  });

  it('turns an unreachable engine into isError naming the URL', async () => {
    const { transport } = fakeTransport(() => new Error('ECONNREFUSED'));
    const client = await connect('dispatcher', transport);
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`Jarvis engine is not reachable at ${URL_BASE}.`);
  });

  it('reports a status-only failure when the body is not an API error', async () => {
    const { transport } = fakeTransport(() => ({ status: 502, body: '<html>' }));
    const client = await connect('dispatcher', transport);
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Jarvis engine answered HTTP 502.');
  });
});

describe('Jarvis MCP server: approve (permission prompt tool)', () => {
  const args = { tool_name: 'Bash', input: { command: 'git status' }, tool_use_id: 'tu_1' };

  it('posts to the permissions endpoint and returns the verdict as one JSON text block', async () => {
    // contract: the CLI parses a single text block holding {behavior, updatedInput|message}
    const verdict = { behavior: 'allow', updatedInput: { command: 'git status' } };
    const { calls, transport } = fakeTransport(() => json(200, verdict));
    const client = await connect('worker', transport);

    const result = await client.callTool({ name: 'approve', arguments: args });

    expect(result.isError).toBeFalsy();
    expect(ApproveResultSchema.parse(JSON.parse(textOf(result)))).toEqual(verdict);
    expect(calls[0]?.url).toBe(`${URL_BASE}/api/agent/permissions`);
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual(args);
  });

  it('passes a deny verdict through', async () => {
    const verdict = { behavior: 'deny', message: 'The owner said no.' };
    const { transport } = fakeTransport(() => json(200, verdict));
    const client = await connect('dispatcher', transport);
    const result = await client.callTool({ name: 'approve', arguments: args });
    expect(JSON.parse(textOf(result))).toEqual(verdict);
  });

  it('denies (fails closed) when the engine cannot be reached', async () => {
    const { transport } = fakeTransport(() => new Error('ECONNREFUSED'));
    const client = await connect('worker', transport);
    const result = await client.callTool({ name: 'approve', arguments: args });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({
      behavior: 'deny',
      message: `Jarvis engine is not reachable at ${URL_BASE}.`,
    });
  });

  it('drops unknown CLI fields instead of rejecting them', () => {
    expect(toolInputSchemas.approve.parse({ ...args, extra: 1 })).toEqual(args);
  });
});

describe('readMcpEnv', () => {
  it('reads the url, token and role', () => {
    expect(
      readMcpEnv({ JARVIS_API_URL: URL_BASE, JARVIS_RUN_TOKEN: TOKEN, JARVIS_ROLE: 'worker' }),
    ).toEqual({ apiUrl: URL_BASE, runToken: TOKEN, role: 'worker' });
  });

  it('fails clearly on missing or invalid values', () => {
    expect(() => readMcpEnv({})).toThrow('JARVIS_API_URL');
    expect(() => readMcpEnv({ JARVIS_API_URL: URL_BASE })).toThrow('JARVIS_RUN_TOKEN');
    expect(() => readMcpEnv({ JARVIS_API_URL: URL_BASE, JARVIS_RUN_TOKEN: TOKEN })).toThrow(
      'JARVIS_ROLE',
    );
  });
});
