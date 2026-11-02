import { StreamEventSchema, type StreamEvent } from '@jarvis/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../application/testing/index.js';
import { SseHub } from '../../infrastructure/sse/sse-hub.js';
import { buildServer } from './server.js';
import { frame } from './routes/stream.js';

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function listening(heartbeatMs = 15_000) {
  const hub = new SseHub();
  server = buildServer(buildTestApp(), { stream: hub, heartbeatMs });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.addresses()[0];
  return { hub, url: `http://127.0.0.1:${address?.port}/api/stream` };
}

/** Reads the response body until `done(text)` says enough has arrived. */
async function readUntil(response: Response, done: (text: string) => boolean): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  while (!done(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  void reader.cancel();
  return text;
}

describe('GET /api/stream', () => {
  it('formats an event as one unnamed message frame with a JSON data line', () => {
    expect(frame({ type: 'task', id: 'T-1' })).toBe('data: {"type":"task","id":"T-1"}\n\n');
  });

  it('answers with an event stream and sends each published event as a frame', async () => {
    const { hub, url } = await listening();
    const response = await fetch(url);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const events: StreamEvent[] = [{ type: 'thread', id: 'th1' }, { type: 'overview' }];
    const reading = readUntil(response, (text) => text.includes('overview'));
    for (const event of events) await hub.publish(event);
    const text = await reading;

    const frames = text.split('\n\n').filter((f) => f.startsWith('data: '));
    expect(frames.map((f) => StreamEventSchema.parse(JSON.parse(f.slice(6))))).toEqual(events);
    expect(text).not.toContain('event:');
  });

  it('sends a ping comment as heartbeat', async () => {
    const { url } = await listening(20);
    const response = await fetch(url);

    const text = await readUntil(response, (t) => t.includes(': ping'));

    expect(text).toContain(': ping\n\n');
  });

  it('forgets the client when it disconnects', async () => {
    const { hub, url } = await listening();
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    await readUntil(response, (t) => t.includes(': connected'));
    expect(hub.size).toBe(1);

    controller.abort();
    for (let i = 0; i < 100 && hub.size > 0; i += 1) await new Promise((r) => setTimeout(r, 5));

    expect(hub.size).toBe(0);
  });

  it('lets the server close while a client is connected', async () => {
    const { url } = await listening();
    const response = await fetch(url);
    await readUntil(response, (t) => t.includes(': connected'));

    await expect(server?.close()).resolves.toBeUndefined();
    server = undefined;
  });
});
