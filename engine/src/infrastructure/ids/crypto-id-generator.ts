import { randomBytes, randomUUID } from 'node:crypto';
import type { IdGenerator } from '../../application/ports/id-generator.js';

/** Random UUIDs for rows and 256-bit URL-safe tokens for runs (ADR-0004). Task ids come from the database. */
export class CryptoIdGenerator implements IdGenerator {
  threadId(): string {
    return randomUUID();
  }

  messageId(): string {
    return randomUUID();
  }

  sessionId(): string {
    return randomUUID();
  }

  runId(): string {
    return randomUUID();
  }

  permissionId(): string {
    return randomUUID();
  }

  token(): string {
    return randomBytes(32).toString('base64url');
  }
}
