import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ApproveResult, ToolInput, ToolName } from '@jarvis/shared';

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** One POST. Rejects when the engine cannot be reached. */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * `node:http` instead of `fetch`: undici's fetch gives up on a response that takes more than
 * 5 minutes to start, and `/agent/permissions` is a long poll (up to the permission expiry).
 */
export const nodeTransport: HttpTransport = (req) =>
  new Promise((resolve, reject) => {
    const send = req.url.startsWith('https:') ? httpsRequest : httpRequest;
    const call = send(req.url, { method: 'POST', headers: req.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    call.on('error', reject);
    call.end(req.body);
  });

/** A failed engine call, already phrased for the model. */
export class ApiCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export interface JarvisApi {
  /** Calls a role tool; resolves with the engine's JSON result. Throws `ApiCallError`. */
  call<T extends Exclude<ToolName, 'approve'>>(tool: T, input: ToolInput<T>): Promise<unknown>;
  /** Asks for the owner's decision on a tool use; resolves when the owner decides or it expires. */
  approve(input: ToolInput<'approve'>): Promise<ApproveResult>;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly runToken: string;
  readonly transport?: HttpTransport;
}

/**
 * A 400 from the engine carries `details` saying which field was wrong; without them the model sees
 * only "Request validation failed" and can do nothing but guess (observed 2026-11-08, when a stale
 * engine rejected `create_task`'s new fields and the agent retried the same call three times).
 */
function detailLines(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((entry) => {
    const { path, message } = (entry ?? {}) as { path?: unknown; message?: unknown };
    if (typeof message !== 'string' || message === '') return [];
    return [typeof path === 'string' && path !== '' ? `${path}: ${message}` : message];
  });
}

function engineMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; details?: unknown };
    if (typeof parsed.message === 'string' && parsed.message !== '') {
      const details = detailLines(parsed.details);
      return details.length === 0 ? parsed.message : `${parsed.message}: ${details.join('; ')}`;
    }
  } catch {
    // not JSON: fall through to the status line
  }
  return `Jarvis engine answered HTTP ${status}.`;
}

export function createApiClient(options: ApiClientOptions): JarvisApi {
  const base = options.baseUrl.replace(/\/+$/, '');
  const transport = options.transport ?? nodeTransport;

  async function post(path: string, input: unknown): Promise<unknown> {
    const body = JSON.stringify(input);
    let res: HttpResponse;
    try {
      res = await transport({
        url: `${base}/api${path}`,
        headers: {
          authorization: `Bearer ${options.runToken}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      });
    } catch {
      throw new ApiCallError(`Jarvis engine is not reachable at ${base}.`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ApiCallError(engineMessage(res.body, res.status));
    }
    try {
      return res.body === '' ? {} : (JSON.parse(res.body) as unknown);
    } catch {
      throw new ApiCallError('Jarvis engine returned a response that is not JSON.');
    }
  }

  return {
    call: (tool, input) => post(`/agent/tools/${tool}`, input),
    approve: async (input) => (await post('/agent/permissions', input)) as ApproveResult,
  };
}
