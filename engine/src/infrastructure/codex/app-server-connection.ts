import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { encodeCodexMessage, initializeCodexAppServer } from './app-server-protocol.js';

const INITIALIZE_TIMEOUT_MS = 8000;

export async function connectCodexAppServer(
  binary: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) {
  const process = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    ...options,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: process.stdout });
  const closed = new Promise<void>((resolve) => process.once('close', () => resolve()));
  let cleanup = () => {};

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Codex app server initialization timed out.')),
        INITIALIZE_TIMEOUT_MS,
      );
      const onError = (error: Error) => reject(error);
      const onClose = () => reject(new Error('Codex app server exited during initialization.'));
      const onLine = (line: string) => {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown } | null;
          if (message?.id !== 1) return;
          if (message.result == null) {
            reject(new Error('Codex app server rejected initialization.'));
            return;
          }
          process.stdin.write(encodeCodexMessage({ method: 'initialized' }), (error) => {
            if (error) reject(error);
            else resolve();
          });
        } catch {
          reject(new Error('Codex app server returned invalid JSON during initialization.'));
        }
      };
      process.on('error', onError);
      process.stdin.on('error', onError);
      process.once('close', onClose);
      lines.on('line', onLine);
      void closed.then(() => {
        process.off('error', onError);
        process.stdin.off('error', onError);
      });
      cleanup = () => {
        clearTimeout(timer);
        lines.off('line', onLine);
        process.off('close', onClose);
      };
      process.stdin.write(initializeCodexAppServer(), (error) => {
        if (error) reject(error);
      });
    });
  } catch (error) {
    process.kill();
    lines.close();
    throw error;
  } finally {
    cleanup();
  }
  return { process, lines, closed };
}
