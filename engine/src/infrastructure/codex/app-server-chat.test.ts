import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { connectCodexAppServer } from './app-server-connection.js';
import { runCodexChat } from './app-server-chat.js';

vi.mock('./app-server-connection.js', () => ({ connectCodexAppServer: vi.fn() }));

function connection(completeBeforeTool = false, tool = 'ui_browser') {
  const lines = Object.assign(new EventEmitter(), { close: vi.fn() });
  const sent: Record<string, unknown>[] = [];
  const emit = (message: unknown) => lines.emit('line', JSON.stringify(message));
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const stdin = {
    writable: true,
    write: (data: string, callback?: (error?: Error) => void) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      sent.push(message);
      callback?.();
      if (message['method'] === 'thread/start')
        queueMicrotask(() => emit({ id: 2, result: { thread: { id: 'thread-test' } } }));
      if (message['method'] === 'turn/start')
        queueMicrotask(() => {
          emit({
            id: 99,
            method: 'item/tool/call',
            params: { threadId: 'thread-test', tool, arguments: {} },
          });
          if (completeBeforeTool)
            emit({
              method: 'turn/completed',
              params: { threadId: 'thread-test', turn: { status: 'completed' } },
            });
        });
      if (message['id'] === 99 && !completeBeforeTool)
        queueMicrotask(() =>
          emit({
            method: 'turn/completed',
            params: { threadId: 'thread-test', turn: { status: 'completed' } },
          }),
        );
    },
    end: () => close(),
  };
  const process = Object.assign(new EventEmitter(), { stdin, kill: vi.fn() });
  vi.mocked(connectCodexAppServer).mockResolvedValueOnce({ process, lines, closed } as never);
  return { sent, lines };
}

describe('Codex browser tool transport', () => {
  it('sends real image content alongside the text evidence manifest', async () => {
    const { sent, lines } = connection();
    await runCodexChat('codex', {
      cwd: '/w',
      env: {},
      prompt: 'check',
      tools: [
        {
          name: 'ui_browser',
          description: 'browse',
          inputSchema: {},
          call: async () => ({
            content: [{ type: 'image', mimeType: 'image/png', data: 'AQID' }],
            evidence: ['screenshots/c1/a.png'],
          }),
        },
      ],
    });
    const reply = sent.find((m) => m['id'] === 99) as {
      result: { contentItems: { type: string; imageUrl?: string; text?: string }[] };
    };
    expect(reply.result.contentItems).toContainEqual({
      type: 'inputImage',
      imageUrl: 'data:image/png;base64,AQID',
    });
    expect(reply.result.contentItems[0]?.text).toContain('screenshots/c1/a.png');
    expect(lines.close).toHaveBeenCalled();
  });

  it('drains a tool accepted before turn completion before run-exit cleanup can start', async () => {
    connection(true);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let completed = false;
    const result = runCodexChat('codex', {
      cwd: '/w',
      env: {},
      prompt: 'check',
      tools: [
        {
          name: 'ui_browser',
          description: 'browse',
          inputSchema: {},
          call: async () => {
            entered();
            await waiting;
            return {};
          },
        },
      ],
    }).then(() => {
      completed = true;
    });
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    release();
    await result;
    expect(completed).toBe(true);
  });

  it('does not hold run exit for an unrelated tool waiting on the owner', async () => {
    connection(true, 'ask_owner');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = runCodexChat('codex', {
      cwd: '/w',
      env: {},
      prompt: 'check',
      tools: [
        {
          name: 'ask_owner',
          description: 'ask',
          inputSchema: {},
          call: async () => {
            await waiting;
            return {};
          },
        },
      ],
    });
    await expect(result).resolves.toBe('');
    release();
  });
});
