import type { Role } from '@jarvis/shared';

/**
 * Who is calling a dispatcher or worker tool. Presentation resolves it from the run token;
 * it is never read from tool input (ADR-0004).
 */
export interface RunIdentity {
  readonly runId: string;
  readonly role: Role;
  readonly threadId: string;
  /** Set for worker runs. */
  readonly taskId?: string;
}
