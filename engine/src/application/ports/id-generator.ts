/** Opaque ids for rows the use cases create. Task ids come from `TaskRepository.nextId()`. */
export interface IdGenerator {
  threadId(): string;
  messageId(): string;
  sessionId(): string;
  runId(): string;
  permissionId(): string;
  /** An unguessable run token (ADR-0004). */
  token(): string;
}
