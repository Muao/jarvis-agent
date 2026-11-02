import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { RunEventsDto } from '@jarvis/shared';
import { FakeEventSource } from '../test/FakeEventSource';
import { textEvent } from '../test/fixtures';
import { keys } from './keys';
import { createLiveStream, type LiveStream } from './stream';

let queryClient: QueryClient;
let invalidate: MockInstance<QueryClient['invalidateQueries']>;
let stream: LiveStream;

beforeEach(() => {
  FakeEventSource.install();
  queryClient = new QueryClient();
  invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  stream = createLiveStream(queryClient, { offlineAfterMs: 1_000, retryMs: 500, now: () => 42 });
  stream.start();
});

afterEach(() => stream.stop());

const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);

describe('event to cache mapping', () => {
  it('opens exactly one EventSource on /api/stream', () => {
    stream.start();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.current.url).toBe('/api/stream');
  });

  it('invalidates the thread and the thread list on a thread event', () => {
    FakeEventSource.current.open();
    FakeEventSource.current.push({ type: 'thread', id: 'th-1' });
    expect(invalidatedKeys()).toEqual([keys.threads.detail('th-1'), keys.threads.list()]);
  });

  it('invalidates task, lists and overview on a task event', () => {
    FakeEventSource.current.open();
    FakeEventSource.current.push({ type: 'task', id: 'T-1' });
    expect(invalidatedKeys()).toEqual([
      keys.tasks.detail('T-1'),
      keys.tasks.list(),
      keys.threads.list(),
      keys.overview,
    ]);
  });

  it('invalidates run events and sessions on a run event', () => {
    FakeEventSource.current.open();
    FakeEventSource.current.push({ type: 'run', id: 'run-1' });
    expect(invalidatedKeys()).toContainEqual(keys.runs.events('run-1'));
    expect(invalidatedKeys()).toContainEqual(keys.sessions.all);
  });

  it('invalidates overview and config', () => {
    FakeEventSource.current.open();
    FakeEventSource.current.push({ type: 'overview' });
    FakeEventSource.current.push({ type: 'config' });
    expect(invalidatedKeys()).toContainEqual(keys.overview);
    expect(invalidatedKeys()).toContainEqual(keys.config);
  });

  it('appends run_event data to the cached list without invalidating (NFR-08)', () => {
    queryClient.setQueryData<RunEventsDto>(keys.runs.events('run-1'), {
      events: [textEvent(1), textEvent(2)],
    });
    FakeEventSource.current.open();
    FakeEventSource.current.push({ type: 'run_event', id: 'run-1', data: textEvent(3) });
    // a duplicate and an out-of-order event
    FakeEventSource.current.push({ type: 'run_event', id: 'run-1', data: textEvent(3) });
    FakeEventSource.current.push({ type: 'run_event', id: 'run-1', data: textEvent(5) });
    FakeEventSource.current.push({ type: 'run_event', id: 'run-1', data: textEvent(4) });

    const cached = queryClient.getQueryData<RunEventsDto>(keys.runs.events('run-1'));
    expect(cached?.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ignores run_event for a run nobody loaded', () => {
    FakeEventSource.current.open();
    FakeEventSource.current.push({ type: 'run_event', id: 'run-9', data: textEvent(1, 'run-9') });
    expect(queryClient.getQueryData(keys.runs.events('run-9'))).toBeUndefined();
  });

  it('ignores malformed frames', () => {
    FakeEventSource.current.open();
    FakeEventSource.current.pushRaw('not json');
    FakeEventSource.current.pushRaw(JSON.stringify({ type: 'unknown' }));
    expect(invalidate).not.toHaveBeenCalled();
    expect(stream.getSnapshot().status).toBe('live');
  });
});

describe('connection status', () => {
  it('goes reconnecting -> live -> reconnecting -> offline -> live and remembers when it was last seen', () => {
    vi.useFakeTimers();
    expect(stream.getSnapshot()).toEqual({ status: 'reconnecting', lastSeenAt: null });

    FakeEventSource.current.open();
    expect(stream.getSnapshot()).toEqual({ status: 'live', lastSeenAt: 42 });

    FakeEventSource.current.fail();
    expect(stream.getSnapshot().status).toBe('reconnecting');
    expect(stream.getSnapshot().lastSeenAt).toBe(42);

    vi.advanceTimersByTime(1_000);
    expect(stream.getSnapshot().status).toBe('offline');

    FakeEventSource.current.open();
    expect(stream.getSnapshot().status).toBe('live');
  });

  it('invalidates everything after a reconnect, but not after the first open', () => {
    FakeEventSource.current.open();
    expect(invalidate).not.toHaveBeenCalled();

    FakeEventSource.current.fail();
    FakeEventSource.current.open();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith();
  });

  it('replaces a source the browser gave up on', () => {
    vi.useFakeTimers();
    FakeEventSource.current.open();
    FakeEventSource.current.fail(true);
    expect(stream.getSnapshot().status).toBe('offline');

    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.current.open();
    expect(stream.getSnapshot().status).toBe('live');
    expect(invalidate).toHaveBeenCalledWith();
  });

  it('notifies subscribers only when the state changes', () => {
    const listener = vi.fn();
    stream.subscribe(listener);
    FakeEventSource.current.open();
    expect(listener).toHaveBeenCalledTimes(1);
    FakeEventSource.current.push({ type: 'overview' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
