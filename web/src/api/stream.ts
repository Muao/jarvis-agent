import { createContext, useContext, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
  StreamEventSchema,
  type RunEvent,
  type RunEventsDto,
  type StreamEvent,
} from '@jarvis/shared';
import { keys } from './keys';

/** The only module besides `client.ts` that talks to the network: one `EventSource` per app (ADR-0010). */
const STREAM_URL = '/api/stream';

export type ConnectionStatus = 'live' | 'reconnecting' | 'offline';

export interface LiveStreamState {
  status: ConnectionStatus;
  /** Epoch ms of the last message or open; null before the first connection. */
  lastSeenAt: number | null;
}

export interface LiveStream {
  /** Opens the connection. Call `stop` to close it. */
  start(): void;
  stop(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): LiveStreamState;
}

interface LiveStreamOptions {
  /** How long `reconnecting` may last before the indicator says `offline`. */
  offlineAfterMs?: number;
  /** Delay before a new `EventSource` replaces one the browser gave up on. */
  retryMs?: number;
  now?: () => number;
}

/** Appends a pushed run event to the cached list without refetching (NFR-08). */
function appendRunEvent(queryClient: QueryClient, runId: string, event: RunEvent): void {
  queryClient.setQueryData<RunEventsDto>(keys.runs.events(runId), (old) => {
    if (!old) return old; // nobody loaded this run yet; the first fetch will include the event
    const last = old.events.at(-1);
    if (!last || event.seq > last.seq) return { events: [...old.events, event] };
    if (old.events.some((known) => known.seq === event.seq)) return old;
    return { events: [...old.events, event].sort((a, b) => a.seq - b.seq) };
  });
}

/** Maps one notification to the cache updates it implies. */
export function applyStreamEvent(queryClient: QueryClient, event: StreamEvent): void {
  const invalidate = (queryKey: readonly unknown[]) =>
    void queryClient.invalidateQueries({ queryKey });
  switch (event.type) {
    case 'thread':
      invalidate(keys.threads.detail(event.id));
      invalidate(keys.threads.list());
      return;
    case 'task':
      invalidate(keys.tasks.detail(event.id));
      invalidate(keys.tasks.list());
      invalidate(keys.threads.list());
      invalidate(keys.overview);
      return;
    case 'run':
      invalidate(keys.runs.events(event.id));
      invalidate(keys.threads.details); // a run starting or ending shows or hides the working row
      invalidate(keys.threads.list()); // and turns a PR Open badge into Thinking and back
      invalidate(keys.sessions.all);
      invalidate(keys.tasks.all);
      return;
    case 'run_event':
      appendRunEvent(queryClient, event.id, event.data);
      return;
    case 'overview':
      invalidate(keys.overview);
      return;
    case 'config':
      invalidate(keys.config);
      invalidate(keys.overview);
      return;
  }
}

export function createLiveStream(
  queryClient: QueryClient,
  options: LiveStreamOptions = {},
): LiveStream {
  const { offlineAfterMs = 8_000, retryMs = 3_000, now = Date.now } = options;
  const listeners = new Set<() => void>();
  let snapshot: LiveStreamState = { status: 'reconnecting', lastSeenAt: null };
  let source: EventSource | null = null;
  let lastSeenAt: number | null = null;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the connection dropped after having been up, so the next open must catch up. */
  let needsCatchUp = false;

  const publish = (status: ConnectionStatus) => {
    if (snapshot.status === status && snapshot.lastSeenAt === lastSeenAt) return;
    snapshot = { status, lastSeenAt };
    for (const listener of listeners) listener();
  };

  const clearTimers = () => {
    clearTimeout(offlineTimer);
    clearTimeout(retryTimer);
    offlineTimer = undefined;
    retryTimer = undefined;
  };

  const connect = () => {
    const es = new EventSource(STREAM_URL);
    source = es;

    es.onopen = () => {
      clearTimers();
      lastSeenAt = now();
      if (needsCatchUp) {
        needsCatchUp = false;
        void queryClient.invalidateQueries();
      }
      publish('live');
    };

    es.onmessage = (message: MessageEvent) => {
      lastSeenAt = now();
      try {
        const parsed = StreamEventSchema.safeParse(JSON.parse(String(message.data)));
        if (parsed.success) applyStreamEvent(queryClient, parsed.data);
      } catch {
        // A malformed frame is ignored; the next notification or the catch-up refetch repairs the cache.
      }
      if (snapshot.status !== 'live') publish('live');
    };

    es.onerror = () => {
      needsCatchUp = true;
      if (es.readyState === EventSource.CLOSED) {
        // The browser gave up: replace the source ourselves.
        publish('offline');
        es.close();
        retryTimer ??= setTimeout(() => {
          retryTimer = undefined;
          if (source === es) connect();
        }, retryMs);
        return;
      }
      publish(snapshot.status === 'offline' ? 'offline' : 'reconnecting');
      offlineTimer ??= setTimeout(() => publish('offline'), offlineAfterMs);
    };
  };

  return {
    start() {
      if (!source) connect();
    },
    stop() {
      clearTimers();
      source?.close();
      source = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

export const LiveStreamContext = createContext<LiveStream | null>(null);

/** Connection status of the app-wide stream. Needs `LiveStreamProvider` above. */
export function useLiveStream(): LiveStreamState {
  const stream = useContext(LiveStreamContext);
  if (!stream) throw new Error('useLiveStream must be used inside <LiveStreamProvider>.');
  return useSyncExternalStore(stream.subscribe, stream.getSnapshot);
}

/** Mutations are disabled unless the engine is reachable. */
export function useCanMutate(): boolean {
  return useLiveStream().status === 'live';
}
