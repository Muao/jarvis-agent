import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, createTaskInNewThread } from '../../application/testing/index.js';
import { SseHub } from '../../infrastructure/sse/sse-hub.js';
import { buildServer } from './server.js';

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const start = (allowedOrigins: readonly string[] = []) => {
  const app = buildTestApp({ realRuns: true });
  const http = buildServer(app, { stream: new SseHub(), allowedOrigins });
  servers.push(http);
  return { app, http };
};

const HOST = '127.0.0.1:4310';

describe('the owner request guard (ADR-0028)', () => {
  it.each([
    ['POST', '/api/usage/reset'],
    ['POST', '/api/threads'],
    ['PUT', '/api/capabilities/skills/x'],
    ['DELETE', '/api/capabilities/skills/x'],
  ])('%s %s without X-Jarvis-Owner is 403', async (method, url) => {
    const { http } = start();
    const res = await http.inject({
      method: method as 'POST',
      url,
      headers: { host: HOST },
      payload: method === 'POST' ? { text: 'hi' } : undefined,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
  });

  it('lets a mutating request through with the header', async () => {
    const { http } = start();
    const res = await http.inject({
      method: 'POST',
      url: '/api/threads',
      headers: { host: HOST, 'x-jarvis-owner': '1' },
      payload: { text: 'Add a page' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('never guards reads', async () => {
    const { http } = start();
    const res = await http.inject({ method: 'GET', url: '/api/overview', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a cross-origin request even with the header, and accepts the same origin', async () => {
    const { http } = start();
    const base = { host: HOST, 'x-jarvis-owner': '1' };
    const cross = await http.inject({
      method: 'POST',
      url: '/api/usage/reset',
      headers: { ...base, origin: 'http://127.0.0.1:3000' },
    });
    expect(cross.statusCode).toBe(403);
    const same = await http.inject({
      method: 'POST',
      url: '/api/usage/reset',
      headers: { ...base, origin: `http://${HOST}` },
    });
    expect(same.statusCode).toBe(200);
  });

  it('accepts a configured allowed origin', async () => {
    const { http } = start(['http://127.0.0.1:5180']);
    const res = await http.inject({
      method: 'POST',
      url: '/api/usage/reset',
      headers: { host: 'engine.ts.net', 'x-jarvis-owner': '1', origin: 'http://127.0.0.1:5180' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('leaves /api/agent/* to the run token: Bearer, no owner header, no Origin needed', async () => {
    const { app, http } = start();
    const { taskId } = await createTaskInNewThread(app);
    const token = app.runner.forTask(taskId)?.spec.runToken;
    if (token === undefined) throw new Error('the worker did not start');

    const ok = await http.inject({
      method: 'POST',
      url: '/api/agent/tools/ask_owner',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(ok.statusCode).not.toBe(403);
    const noToken = await http.inject({ method: 'POST', url: '/api/agent/tools/ask_owner' });
    expect(noToken.statusCode).toBe(401);
  });
});
