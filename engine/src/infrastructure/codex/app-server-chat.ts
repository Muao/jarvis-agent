import { connectCodexAppServer } from './app-server-connection.js';
import { encodeCodexMessage } from './app-server-protocol.js';

const TURN_TIMEOUT_MS = 120_000;

interface Message {
  id?: number;
  method?: string;
  error?: unknown;
  result?: { thread?: { id?: string } };
  params?: { threadId?: string; delta?: string; turn?: { status?: string } };
}

/** Runs an ephemeral read-only turn on an initialized stdio connection. */
export async function runCodexChat(
  binary: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; prompt: string; signal?: AbortSignal },
): Promise<string> {
  const { prompt, ...connection } = options;
  const { cwd } = connection;
  const { process, lines } = await connectCodexAppServer(binary, connection);

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Codex chat turn timed out.')),
        TURN_TIMEOUT_MS,
      );
      const chunks: string[] = [];
      let threadId: string | undefined;

      function finish(error?: Error) {
        clearTimeout(timer);
        process.off('close', onClose);
        lines.off('line', onLine);
        if (error) reject(error);
        else resolve(chunks.join(''));
      }

      function onClose() {
        finish(new Error('Codex exited before the chat turn completed.'));
      }

      function send(message: Readonly<Record<string, unknown>>) {
        process.stdin.write(encodeCodexMessage(message), (error) => {
          if (error) finish(error);
        });
      }

      function onLine(line: string) {
        let message: Message | null;
        try {
          message = JSON.parse(line) as Message | null;
        } catch {
          finish(new Error('Codex returned invalid JSON during the chat turn.'));
          return;
        }

        if ((message?.id === 2 || message?.id === 3) && message.error) {
          finish(new Error('Codex rejected the chat request.'));
          return;
        }
        if (message?.id === 2) {
          threadId = message.result?.thread?.id;
          if (typeof threadId !== 'string' || !threadId) {
            finish(new Error('Codex did not return a thread ID.'));
            return;
          }
          send({
            id: 3,
            method: 'turn/start',
            params: { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] },
          });
          return;
        }
        if (!threadId || message?.params?.threadId !== threadId) return;
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
        method: 'thread/start',
        params: { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true },
      });
    });
  } finally {
    lines.close();
    process.kill();
  }
}
