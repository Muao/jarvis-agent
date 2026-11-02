import type { ZodType } from 'zod';
import { ApiErrorSchema } from '@jarvis/shared';

/** The only module besides `stream.ts` that calls `fetch` (ADR-0012). */
const API_BASE = '/api';

/** A non-2xx response (or an unreadable 2xx body) carrying the shared `{ code, message }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The engine could not be reached at all. */
export class NetworkError extends Error {
  constructor(options?: ErrorOptions) {
    super('Cannot reach the engine.', options);
    this.name = 'NetworkError';
  }
}

export function buildPath(path: string, params?: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return `${API_BASE}${path}${query ? `?${query}` : ''}`;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const parsed = ApiErrorSchema.safeParse(await readJson(res));
  if (parsed.success) {
    const { code, message, details } = parsed.data;
    return new ApiError(res.status, code, message, details);
  }
  return new ApiError(res.status, 'unknown', `Request failed (${res.status}).`);
}

async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new NetworkError({ cause });
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

async function parseWith<T>(res: Response, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(res));
  if (!parsed.success) {
    throw new ApiError(res.status, 'invalid_response', 'The engine sent an unexpected response.');
  }
  return parsed.data;
}

export async function get<T>(
  path: string,
  schema: ZodType<T>,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  return parseWith(await send('GET', buildPath(path, params)), schema);
}

/** POST whose response body is parsed with `schema`. */
export async function post<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> {
  return parseWith(await send('POST', buildPath(path), body), schema);
}

/** POST whose response body is not used; callers invalidate the affected queries instead. */
export async function postVoid(path: string, body?: unknown): Promise<void> {
  await send('POST', buildPath(path), body);
}
