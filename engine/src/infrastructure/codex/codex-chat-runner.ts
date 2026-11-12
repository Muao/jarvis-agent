import type { AgentRunner, RunListener, RunSpec } from '../../application/ports/agent-runner.js';
import { EMPTY_USAGE, type RunOutcome } from '../../domain/run.js';
import { runCodexChat } from './app-server-chat.js';

export class CodexChatRunner implements AgentRunner {
  constructor(
    private readonly binary: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  start(spec: RunSpec, listener: RunListener) {
    const controller = new AbortController();
    const finished = this.run(spec, listener, controller.signal);
    return {
      send() {},
      async stop() {
        controller.abort();
        await finished;
      },
    };
  }

  private async run(spec: RunSpec, listener: RunListener, signal: AbortSignal): Promise<void> {
    let outcome: RunOutcome;
    try {
      if (spec.role !== 'dispatcher') {
        throw new Error(
          'Codex currently supports read-only chat. Task workers require Claude Code.',
        );
      }
      const reply = await runCodexChat(this.binary, {
        cwd: spec.cwd,
        env: this.env,
        prompt: spec.firstMessage,
        signal,
      });
      outcome = {
        type: 'result',
        subtype: 'success',
        turns: 1,
        costUsd: 0,
        usage: EMPTY_USAGE,
        dispatcherReply: reply,
      };
      if (!signal.aborted) await listener.event({ kind: 'text', payload: { text: reply } });
    } catch (error) {
      outcome = {
        type: 'exit',
        code: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await listener.exit(signal.aborted ? { type: 'stopped' } : outcome);
  }
}
