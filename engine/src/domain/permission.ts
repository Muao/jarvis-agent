import { DomainError } from './errors.js';
import { addMinutes, toMs, type IsoTime } from './time.js';

export type PermissionStatus = 'pending' | 'allow' | 'deny' | 'timeout';
export type PermissionDecision = 'allow' | 'deny';

export interface PermissionRequest {
  readonly id: string;
  readonly runId: string;
  readonly threadId: string;
  readonly taskId: string | null;
  readonly tool: string;
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly status: PermissionStatus;
  readonly requestedAt: IsoTime;
  readonly expiresAt: IsoTime;
  readonly decidedAt: IsoTime | null;
}

export function requestPermission(input: {
  id: string;
  runId: string;
  threadId: string;
  taskId: string | null;
  tool: string;
  description: string;
  input: Readonly<Record<string, unknown>>;
  at: IsoTime;
  timeoutMinutes: number;
}): PermissionRequest {
  return {
    id: input.id,
    runId: input.runId,
    threadId: input.threadId,
    taskId: input.taskId,
    tool: input.tool,
    description: input.description,
    input: input.input,
    status: 'pending',
    requestedAt: input.at,
    expiresAt: addMinutes(input.at, input.timeoutMinutes),
    decidedAt: null,
  };
}

export function isExpired(request: Pick<PermissionRequest, 'expiresAt'>, now: IsoTime): boolean {
  return toMs(now) >= toMs(request.expiresAt);
}

function assertPending(request: PermissionRequest): void {
  if (request.status !== 'pending') {
    throw new DomainError(
      'already_decided',
      `Permission ${request.id} is already decided (${request.status})`,
    );
  }
}

/** SLK-05: the owner decides once, and only before the request expires. */
export function decidePermission(
  request: PermissionRequest,
  decision: PermissionDecision,
  at: IsoTime,
): PermissionRequest {
  assertPending(request);
  if (isExpired(request, at)) {
    throw new DomainError('permission_expired', `Permission ${request.id} has expired`);
  }
  return { ...request, status: decision, decidedAt: at };
}

/** SLK-05: no answer in time means deny. */
export function timeoutPermission(request: PermissionRequest, now: IsoTime): PermissionRequest {
  assertPending(request);
  if (!isExpired(request, now)) {
    throw new DomainError('permission_not_expired', `Permission ${request.id} has not expired yet`);
  }
  return { ...request, status: 'timeout', decidedAt: now };
}
