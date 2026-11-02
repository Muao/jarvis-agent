import type { ApiError } from '@jarvis/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DomainError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
} from '../../application/index.js';

export interface ValidationDetail {
  readonly path: string;
  readonly message: string;
}

/** The request body, query or params do not match the shared schema. Maps to 400. */
export class RequestValidationError extends Error {
  readonly details: readonly ValidationDetail[];

  constructor(details: readonly ValidationDetail[]) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
    this.details = details;
  }
}

/** No (or a malformed) `Authorization: Bearer` header on an agent route. Maps to 401. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export interface MappedError {
  readonly status: number;
  readonly body: ApiError;
}

function frameworkStatus(error: unknown): number | null {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

/** The one place where errors become HTTP (ADR-0003). */
export function mapError(error: unknown, redact: (text: string) => string): MappedError {
  if (error instanceof RequestValidationError) {
    return {
      status: 400,
      body: { code: 'validation_failed', message: error.message, details: error.details },
    };
  }
  if (error instanceof UnauthorizedError) {
    return { status: 401, body: { code: 'unauthorized', message: error.message } };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, body: { code: 'not_found', message: error.message } };
  }
  if (error instanceof ForbiddenError) {
    return { status: 403, body: { code: 'forbidden', message: error.message } };
  }
  if (error instanceof InvalidInputError) {
    return { status: 400, body: { code: 'invalid_input', message: error.message } };
  }
  if (error instanceof DomainError) {
    return { status: 409, body: { code: error.code, message: error.message } };
  }
  // Malformed JSON, unsupported media type, body over the limit.
  const status = frameworkStatus(error);
  if (status !== null) {
    return { status, body: { code: 'bad_request', message: 'Malformed request.' } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { code: 'internal', message: redact(message) } };
}

export function registerErrorHandling(
  app: FastifyInstance,
  redact: (text: string) => string,
): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapError(error, redact);
    if (mapped.status >= 500) {
      request.log.error({ message: mapped.body.message }, 'unhandled error');
    }
    return reply.code(mapped.status).send(mapped.body);
  });

  app.setNotFoundHandler((request, reply) => {
    const route = `${request.method} ${request.url.split('?')[0] ?? ''}`;
    const body: ApiError = { code: 'not_found', message: `No such route: ${route}` };
    return reply.code(404).send(body);
  });
}
