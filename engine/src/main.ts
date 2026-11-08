// Process entry point (ADR-0003 composition root): start the engine on the owner's laptop.
import { createContainer, type Container } from './container.js';
import { assertSubscriptionOnly, StartupError } from './infrastructure/config/index.js';

import { startTimers, type RunningTimers } from './presentation/timers/index.js';

// Fastify's own request logging; the engine's lifecycle lines use JARVIS_LOG_LEVEL (ConsoleLogger).
// At info it would write two lines per HTTP request, which the SPA makes constantly.
const LOG_LEVEL = 'warn';

async function main(): Promise<void> {
  assertSubscriptionOnly(process.env);
  const container = await createContainer({ env: process.env, logger: { level: LOG_LEVEL } });
  const timers: { current: RunningTimers | undefined } = { current: undefined };
  stopOnSignal(container, timers);

  // Listen before recovery: re-queued workers need the API to reach the engine.
  const url = await container.listen();
  await container.app.resumeAfterRestart.execute();
  // Timers last: the watcher's first poll must see the state recovery left behind.
  timers.current = startTimers(container.app, container.timerDeps);
  process.stdout.write(`Jarvis engine listening on ${url}\n`);
}

function stopOnSignal(container: Container, timers: { current: RunningTimers | undefined }): void {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${signal} received, shutting down\n`);
    (timers.current?.stop() ?? Promise.resolve())
      .then(() => container.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          process.stderr.write(`Shutdown failed: ${String(error)}\n`);
          process.exit(1);
        },
      );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error: unknown) => {
  const message =
    error instanceof StartupError
      ? error.message
      : `Jarvis failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
