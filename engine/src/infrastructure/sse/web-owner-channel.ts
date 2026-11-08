import type { EventBus } from '../../application/ports/event-bus.js';
import type { OwnerChannel } from '../../application/ports/owner-channel.js';
import type { Message } from '../../domain/index.js';

/**
 * The web chat as the owner's channel (ADR-0006): the message is already stored, so telling the
 * browser that the thread changed is all there is to do. The web refetches the thread.
 */
export class WebOwnerChannel implements OwnerChannel {
  constructor(private readonly events: EventBus) {}

  deliver(message: Message): Promise<void> {
    return this.events.publish({ type: 'thread', id: message.threadId });
  }

  updated(message: Message): Promise<void> {
    return this.events.publish({ type: 'thread', id: message.threadId });
  }
}
