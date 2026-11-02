export type DomainErrorCode =
  | 'illegal_transition'
  | 'already_answered'
  | 'task_cancelled'
  | 'not_a_card'
  | 'already_decided'
  | 'permission_expired'
  | 'permission_not_expired'
  | 'run_not_running';

/** The only error the domain throws; presentation maps `code` to HTTP once. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
