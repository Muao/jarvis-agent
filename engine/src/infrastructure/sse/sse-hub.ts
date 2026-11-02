import type { StreamEvent } from '@jarvis/shared';
import type { EventBus } from '../../application/ports/event-bus.js';

export type StreamListener = (event: StreamEvent) => void;

/**
 * Fan-out of live notifications to the connected `GET /api/stream` clients (ADR-0008).
 * Presentation subscribes through the `StreamSource` shape; use cases publish through `EventBus`.
 */
export class SseHub implements EventBus {
  private readonly listeners = new Set<StreamListener>();

  /** Returns the function that ends the subscription. */
  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async publish(event: StreamEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken connection must not stop the others.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
