/** Every failure of the GitHub adapter; the message never contains the token (SEC-04). */
export class CodeHostError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CodeHostError';
    this.status = status;
  }
}
