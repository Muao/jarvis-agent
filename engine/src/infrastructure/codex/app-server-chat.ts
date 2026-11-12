import { connectCodexAppServer } from './app-server-connection.js';
import { encodeCodexMessage } from './app-server-protocol.js';
import type { TokenUsage } from '@jarvis/shared';

const TURN_TIMEOUT_MS = 120_000;

interface Message {
  id?: number | string;
  method?: string;
  error?: unknown;
  result?: { thread?: { id?: string } };
  params?: {
    threadId?: string;
    delta?: string;
    turn?: { id?: string; status?: string };
    tool?: string;
    namespace?: string | null;
    arguments?: unknown;
    command?: string;
    cwd?: string;
    reason?: string;
    itemId?: string;
    tokenUsage?: {
      total?: UsageBreakdown;
      last?: UsageBreakdown;
    };
  };
}

interface UsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

function usageOf(value: UsageBreakdown): TokenUsage {
  const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
  const cacheRead = count(value.cachedInputTokens);
  return {
    input: Math.max(0, count(value.inputTokens) - cacheRead),
    output: count(value.outputTokens),
    cacheRead,
    cacheWrite: count(value.cacheWriteInputTokens),
  };
}

function subtractUsage(total: TokenUsage, earlier: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, total.input - earlier.input),
    output: Math.max(0, total.output - earlier.output),
    cacheRead: Math.max(0, total.cacheRead - earlier.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - earlier.cacheWrite),
  };
}

export interface CodexTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  call(input: unknown): Promise<unknown>;
}

/** Starts or resumes a thread and returns the turn's reply. */
export async function runCodexChat(
  binary: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: string;
    signal?: AbortSignal;
    resumeThreadId?: string;
    onThread?: (threadId: string) => Promise<void>;
    tools?: readonly CodexTool[];
    instructions?: string;
    writableRoots?: readonly string[];
    approveCommand?: (input: Record<string, unknown>) => Promise<boolean>;
    onTurn?: (steer: (text: string) => void) => void;
    timeoutMs?: number;
    model?: string;
    onUsage?: (usage: TokenUsage) => void;
  },
): Promise<string> {
  const {
    prompt,
    resumeThreadId,
    onThread,
    tools,
    instructions,
    writableRoots,
    approveCommand,
    onTurn,
    timeoutMs,
    model,
    onUsage,
    ...connection
  } = options;
  const { cwd } = connection;
  const { process, lines, closed } = await connectCodexAppServer(binary, connection);
  let threadId: string | undefined;

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Codex chat turn timed out.')),
        timeoutMs ?? TURN_TIMEOUT_MS,
      );
      const chunks: string[] = [];
      let finished = false;
      let requestId = 3;
      let previousTurns: TokenUsage | undefined;
      const approvalPolicy = approveCommand ? 'on-request' : 'never';
      let threadMethod = resumeThreadId ? 'thread/resume' : 'thread/start';
      const threadOptions = {
        cwd,
        ...(model ? { model } : {}),
        sandbox: writableRoots ? 'workspace-write' : 'read-only',
        approvalPolicy,
        ...(instructions ? { developerInstructions: instructions } : {}),
      };

      function finish(error?: Error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        process.off('close', onClose);
        lines.off('line', onLine);
        if (error) reject(error);
        else if (threadId && onThread)
          void onThread(threadId).then(() => resolve(chunks.join('')), reject);
        else resolve(chunks.join(''));
      }

      function onClose() {
        finish(new Error('Codex exited before the chat turn completed.'));
      }

      function send(message: Readonly<Record<string, unknown>>) {
        if (finished) return;
        process.stdin.write(encodeCodexMessage(message), (error) => {
          if (error) finish(error);
        });
      }

      async function respondToTool(id: number | string, params: NonNullable<Message['params']>) {
        try {
          const tool = tools?.find(({ name }) => name === params.tool);
          if (!tool || params.namespace != null) {
            throw new Error('This Jarvis tool is unavailable.');
          }
          const result = await tool.call(params.arguments);
          send({
            id,
            result: {
              success: true,
              contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
            },
          });
        } catch (error) {
          send({
            id,
            result: {
              success: false,
              contentItems: [
                {
                  type: 'inputText',
                  text: error instanceof Error ? error.message : 'Jarvis tool failed.',
                },
              ],
            },
          });
        }
      }

      async function respondToApproval(
        id: number | string,
        params: NonNullable<Message['params']>,
      ) {
        const allowed =
          approveCommand &&
          typeof params.command === 'string' &&
          (await approveCommand({
            command: params.command,
            cwd: params.cwd ?? cwd,
            reason: params.reason ?? '',
            itemId: params.itemId ?? '',
          }).catch(() => false));
        send({ id, result: { decision: allowed ? 'accept' : 'decline' } });
      }

      function onLine(line: string) {
        let message: Message | null;
        try {
          message = JSON.parse(line) as Message | null;
        } catch {
          finish(new Error('Codex returned invalid JSON during the chat turn.'));
          return;
        }

        if (message?.method === undefined && typeof message?.id === 'number' && message.error) {
          const operation =
            message.id === 2 ? threadMethod : message.id === 3 ? 'turn/start' : 'turn/steer';
          const error = message.error as { message?: unknown };
          const detail =
            typeof error.message === 'string'
              ? error.message.replace(/\s+/g, ' ').slice(0, 300)
              : 'Request rejected';
          if (
            operation === 'thread/resume' &&
            resumeThreadId &&
            detail === `thread ${resumeThreadId} already has an active writer`
          ) {
            threadMethod = 'thread/fork';
            send({
              id: 2,
              method: threadMethod,
              params: { ...threadOptions, threadId: resumeThreadId, excludeTurns: true },
            });
            return;
          }
          finish(new Error(`Codex ${operation}: ${detail}`));
          return;
        }
        if (message?.method === undefined && message?.id === 2) {
          threadId = message.result?.thread?.id;
          if (typeof threadId !== 'string' || !threadId) {
            finish(new Error('Codex did not return a thread ID.'));
            return;
          }
          send({
            id: 3,
            method: 'turn/start',
            params: {
              threadId,
              ...(model ? { model } : {}),
              input: [{ type: 'text', text: prompt, text_elements: [] }],
              ...(writableRoots
                ? {
                    sandboxPolicy: {
                      type: 'workspaceWrite',
                      writableRoots,
                      networkAccess: false,
                      excludeTmpdirEnvVar: true,
                      excludeSlashTmp: true,
                    },
                  }
                : {}),
            },
          });
          return;
        }
        if (!threadId || message?.params?.threadId !== threadId) return;
        if (message.method === 'thread/tokenUsage/updated' && onUsage) {
          const usage = message.params.tokenUsage;
          if (usage?.total && usage.last) {
            const total = usageOf(usage.total);
            previousTurns ??= subtractUsage(total, usageOf(usage.last));
            onUsage(subtractUsage(total, previousTurns));
          }
          return;
        }
        const activeTurn = message.params.turn?.id;
        if (message.method === 'turn/started' && activeTurn && onTurn) {
          const activeThread = threadId;
          onTurn((text) =>
            send({
              id: ++requestId,
              method: 'turn/steer',
              params: {
                threadId: activeThread,
                expectedTurnId: activeTurn,
                input: [{ type: 'text', text, text_elements: [] }],
              },
            }),
          );
          return;
        }
        if (message.method === 'item/tool/call' && message.id !== undefined) {
          void respondToTool(message.id, message.params);
          return;
        }
        if (
          message.method === 'item/commandExecution/requestApproval' &&
          message.id !== undefined
        ) {
          void respondToApproval(message.id, message.params);
          return;
        }
        if (message.id !== undefined && message.method) {
          send({
            id: message.id,
            error: { code: -32601, message: 'Request is unavailable in Jarvis.' },
          });
          return;
        }
        if (
          message.method === 'item/agentMessage/delta' &&
          typeof message.params.delta === 'string'
        ) {
          chunks.push(message.params.delta);
        }
        if (message.method === 'turn/completed') {
          const status = message.params.turn?.status;
          finish(
            status === 'completed' ? undefined : new Error('Codex did not complete the chat turn.'),
          );
        }
      }

      process.once('close', onClose);
      lines.on('line', onLine);
      send({
        id: 2,
        method: threadMethod,
        params: {
          ...threadOptions,
          ...(resumeThreadId
            ? { threadId: resumeThreadId, excludeTurns: true }
            : {
                ephemeral: !onThread,
                ...(tools?.length
                  ? {
                      dynamicTools: tools.map((tool) => ({
                        type: 'function',
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                      })),
                    }
                  : {}),
              }),
        },
      });
    });
  } finally {
    // Let Codex release its persisted thread writer before the scheduler starts another run.
    if (threadId && process.stdin.writable) {
      process.stdin.write(
        encodeCodexMessage({
          id: 0,
          method: 'thread/unsubscribe',
          params: { threadId },
        }),
      );
    }
    process.stdin.end();
    const terminate = setTimeout(() => process.kill(), 1500);
    const forceKill = setTimeout(() => process.kill('SIGKILL'), 3000);
    await closed;
    clearTimeout(terminate);
    clearTimeout(forceKill);
    lines.close();
  }
}
