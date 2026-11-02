import type { StreamEvent } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../domain/index.js';
import { SseHub } from './sse-hub.js';
import { WebOwnerChannel } from './web-owner-channel.js';

describe('SseHub', () => {
  it('delivers every event to every subscriber until they leave', async () => {
    const hub = new SseHub();
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    const leaveA = hub.subscribe((e) => a.push(e));
    hub.subscribe((e) => b.push(e));

    await hub.publish({ type: 'overview' });
    leaveA();
    await hub.publish({ type: 'task', id: 'T-1' });

    expect(a).toEqual([{ type: 'overview' }]);
    expect(b).toEqual([{ type: 'overview' }, { type: 'task', id: 'T-1' }]);
    expect(hub.size).toBe(1);
  });

  it('keeps going when one subscriber throws', async () => {
    const hub = new SseHub();
    const seen: StreamEvent[] = [];
    hub.subscribe(() => {
      throw new Error('broken pipe');
    });
    hub.subscribe((e) => seen.push(e));
    await hub.publish({ type: 'config' });
    expect(seen).toEqual([{ type: 'config' }]);
  });
});

describe('WebOwnerChannel', () => {
  it('publishes a thread event for delivered and updated messages', async () => {
    const hub = new SseHub();
    const seen: StreamEvent[] = [];
    hub.subscribe((e) => seen.push(e));
    const channel = new WebOwnerChannel(hub);
    const message = { id: 'm1', threadId: 'th1' } as Message;

    await channel.deliver(message);
    await channel.updated(message);

    expect(seen).toEqual([
      { type: 'thread', id: 'th1' },
      { type: 'thread', id: 'th1' },
    ]);
  });
});
