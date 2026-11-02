import { act } from '@testing-library/react';
import type { StreamEvent } from '@jarvis/shared';

type Handler = ((event: Event) => void) | null;

/**
 * In-memory `EventSource`. `FakeEventSource.install()` swaps it into `globalThis`; drive the connection with
 * `open()`, `push()` and `fail()`. Handlers run inside `act` so React state updates flush.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  private static original: typeof EventSource | undefined;
  private static installed = false;

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: Handler = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: Handler = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    act(() => this.onopen?.(new Event('open')));
  }

  /** Delivers one `StreamEvent` as an unnamed JSON frame. */
  push(event: StreamEvent): void {
    act(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) })));
  }

  pushRaw(data: string): void {
    act(() => this.onmessage?.(new MessageEvent('message', { data })));
  }

  /** A dropped connection. `giveUp` mirrors the browser abandoning the retry loop (readyState CLOSED). */
  fail(giveUp = false): void {
    this.readyState = giveUp ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    act(() => this.onerror?.(new Event('error')));
  }

  static install(): void {
    if (FakeEventSource.installed) return;
    FakeEventSource.original = globalThis.EventSource;
    FakeEventSource.installed = true;
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  }

  static uninstall(): void {
    if (!FakeEventSource.installed) return;
    if (FakeEventSource.original) globalThis.EventSource = FakeEventSource.original;
    else Reflect.deleteProperty(globalThis, 'EventSource');
    FakeEventSource.instances = [];
    FakeEventSource.original = undefined;
    FakeEventSource.installed = false;
  }

  /** The newest connection. */
  static get current(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error('No EventSource was opened.');
    return last;
  }
}
