import type { Role } from '@jarvis/shared';

/** One Claude CLI session: a dispatcher session per thread, a worker session per task. */
export interface Session {
  readonly id: string;
  readonly role: Role;
  readonly threadId: string;
  readonly taskId: string | null;
  /** The CLI's own session id, used with `--resume`; null before the first run reports it. */
  readonly claudeSessionId: string | null;
}

export interface SessionRepository {
  get(id: string): Promise<Session | null>;
  /** Insert or update. */
  save(session: Session): Promise<void>;
  /** The thread's dispatcher session, if a dispatcher turn ever ran there. */
  dispatcherOf(threadId: string): Promise<Session | null>;
}
