import type { Message } from '../../domain/index.js';

/**
 * How the owner sees the conversation (ADR-0006). Use cases persist messages through the unit of
 * work, then call these after commit; the web adapter publishes SSE, the Slack adapter posts.
 */
export interface OwnerChannel {
  /** A new message exists in `message.threadId`. */
  deliver(message: Message): Promise<void>;
  /** An existing message changed in place (status card, answered card, delivery state). */
  updated(message: Message): Promise<void>;
}
