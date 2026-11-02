import { describe, expect, it, vi } from 'vitest';
import { TextBodySchema } from '@jarvis/shared';
import { stubFetch } from '../test/fakeFetch';
import { ApiError, NetworkError, get, post, postVoid } from './client';

const Pong = TextBodySchema;

describe('api client', () => {
  it('parses a successful response with the given schema', async () => {
    stubFetch({ 'GET /api/ping': { text: 'pong' } });
    await expect(get('/ping', Pong)).resolves.toEqual({ text: 'pong' });
  });

  it('maps a shared { code, message } body to ApiError', async () => {
    stubFetch({
      'GET /api/tasks/T-9': {
        status: 404,
        body: { code: 'task_not_found', message: 'No such task', details: { id: 'T-9' } },
      },
    });
    const error = await get('/tasks/T-9', Pong).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'task_not_found',
      message: 'No such task',
      details: { id: 'T-9' },
    });
  });

  it('falls back to code "unknown" when the error body is not the shared shape', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>oops</html>', { status: 502 }));
    await expect(get('/ping', Pong)).rejects.toMatchObject({
      status: 502,
      code: 'unknown',
      message: 'Request failed (502).',
    });
  });

  it('reports a response that does not match the schema as invalid_response', async () => {
    stubFetch({ 'GET /api/ping': { text: 5 } });
    await expect(get('/ping', Pong)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('wraps a failed fetch in NetworkError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(get('/ping', Pong)).rejects.toBeInstanceOf(NetworkError);
  });

  it('posts JSON and sends the query string for GET params', async () => {
    const spy = stubFetch({
      'POST /api/threads/th-1/messages': {},
      'GET /api/ping': { text: 'pong' },
    });
    await postVoid('/threads/th-1/messages', { text: 'hi' });
    expect(spy).toHaveBeenCalledWith('/api/threads/th-1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"text":"hi"}',
    });

    await get('/ping', Pong, { afterSeq: 3, skip: undefined });
    expect(spy).toHaveBeenLastCalledWith(
      '/api/ping?afterSeq=3',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('throws ApiError from post as well', async () => {
    stubFetch({
      'POST /api/x': { status: 409, body: { code: 'conflict', message: 'Already answered' } },
    });
    await expect(post('/x', {}, Pong)).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });
});
