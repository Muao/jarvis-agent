import { describe, expect, it, vi } from 'vitest';
import type { RunSpec } from '../../application/ports/agent-runner.js';
import { runCodexChat } from './app-server-chat.js';
import { CodexChatRunner } from './codex-chat-runner.js';

vi.mock('./app-server-chat.js', () => ({ runCodexChat: vi.fn() }));

const dispatcher: RunSpec = {
  runId: 'run-1',
  role: 'dispatcher',
  cwd: '/test/repo',
  firstMessage: 'Build a page.',
  model: 'default',
  maxTurns: 5,
  maxBudgetUsd: 1,
  runToken: 'test-run-token',
  keepStdinOpen: false,
  threadId: 'thread-1',
  sessionId: 'session-1',
};

function fixture() {
  const callTool = vi.fn(async () => ({ id: 'T-1' }));
  const approveCommand = vi.fn(async () => true);
  const runner = new CodexChatRunner({
    binary: 'codex',
    env: {},
    artifactsDir: () => '/test/artifacts/T-1',
    instructions: async () => '',
    descriptions: {} as ConstructorParameters<typeof CodexChatRunner>[0]['descriptions'],
    callTool,
    approveCommand,
    timeoutMs: () => 1000,
  });
  const listener = { event: vi.fn(), session: vi.fn(), exit: vi.fn() };
  return { runner, callTool, approveCommand, listener };
}

describe('CodexChatRunner', () => {
  it('exposes validated build creation to the dispatcher without exposing worker tools', async () => {
    const { runner, callTool, listener } = fixture();
    vi.mocked(runCodexChat).mockImplementationOnce(async (_, options) => {
      expect(options.writableRoots).toBeUndefined();
      expect(options.tools?.some(({ name }) => name === 'open_pr')).toBe(false);
      const create = options.tools?.find(({ name }) => name === 'create_task');
      expect(create).toBeDefined();
      await expect(
        create!.call({ title: 'Page', description: 'Add a page', kind: 'ui_check' }),
      ).rejects.toThrow('Use a build task');
      await create!.call({ title: 'Page', description: 'Add a page' });
      return 'Created T-1';
    });
    runner.start(dispatcher, listener);
    await vi.waitFor(() => expect(listener.exit).toHaveBeenCalled());
    expect(callTool).toHaveBeenCalledExactlyOnceWith(dispatcher, 'create_task', {
      title: 'Page',
      description: 'Add a page',
    });
    expect(listener.exit).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherReply: 'Created T-1',
      }),
    );
  });

  it('limits the worker to its workspace and routes a command approval through Jarvis', async () => {
    const { runner, approveCommand, listener } = fixture();
    const worker: RunSpec = {
      ...dispatcher,
      role: 'worker',
      taskKind: 'build',
      taskId: 'T-1',
      cwd: '/test/worktree',
    };
    vi.mocked(runCodexChat).mockImplementationOnce(async (_, options) => {
      expect(options.writableRoots).toEqual(['/test/worktree', '/test/artifacts/T-1']);
      expect(options.tools?.some(({ name }) => name === 'submit_spec_for_approval')).toBe(true);
      expect(options.tools?.some(({ name }) => name === 'create_task')).toBe(false);
      await options.approveCommand?.({ command: 'git status' });
      return 'Spec submitted';
    });
    runner.start(worker, listener);
    await vi.waitFor(() => expect(listener.exit).toHaveBeenCalled());
    expect(approveCommand).toHaveBeenCalledExactlyOnceWith(worker, { command: 'git status' });
    expect(listener.exit).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Spec submitted' }),
    );
  });
});
