import {
  CODEX_SESSION_PREFIX,
  type AgentRunner,
  type RunListener,
  type RunSpec,
} from '../../application/ports/agent-runner.js';
import { EMPTY_USAGE, type RunOutcome } from '../../domain/run.js';
import { runCodexChat, type CodexTool } from './app-server-chat.js';
import {
  CodexTaskModelSchema,
  toolInputSchemas,
  toolsByRole,
  type ToolInput,
  type ToolName,
} from '@jarvis/shared';

type CallableTool = Exclude<ToolName, 'approve'>;

interface RunnerOptions {
  readonly binary: string;
  readonly env: NodeJS.ProcessEnv;
  readonly artifactsDir: (taskId: string) => string;
  readonly instructions: (role: RunSpec['role']) => Promise<string>;
  readonly descriptions: Readonly<Record<ToolName, string>>;
  callTool(spec: RunSpec, name: CallableTool, input: ToolInput<CallableTool>): Promise<unknown>;
  approveCommand(spec: RunSpec, input: Record<string, unknown>): Promise<boolean>;
  timeoutMs(spec: RunSpec): number;
}

const DISPATCHER_INSTRUCTIONS = [
  'Use create_task for an explicit request to implement a change. Keep its description self-contained.',
  'Build tasks pause for the owner to approve the specification before implementation.',
  'For questions about existing tasks use list_tasks. Reply to the owner in your final answer.',
  'Browser-only PR checks and per-task Claude model selection are unavailable on this backend.',
].join(' ');

const WORKER_INSTRUCTIONS = [
  'Carry out the Jarvis build workflow described in your run context.',
  'Do the work for the current stage yourself. One-step guidance applies when giving the owner instructions, so do not pause for routine inspection, commands, or file edits you can perform. Pause at the requested stage, an approval gate, or a question that actually requires the owner.',
  'In Context, inspect the repository and write context.md, spec.md, plan.md and tasks.md in the artifacts directory.',
  'Find the repository check commands and pass them as checkCommands to submit_spec_for_approval. End your turn after it returns a cardId.',
  'Wait for the engine to resume you after approval.',
  'Only implement after approval. Use report_stage to report Implementing and Reviewing as appropriate.',
  'Make code changes in the task worktree, verify them, and commit the changes. Ask approval if Git requires access outside the sandbox.',
  'Review the diff yourself. If the engine requires a browser check, report the blocker to the owner.',
  'Call open_pr to run the engine checks and open the draft PR. Never push or open a PR directly.',
].join(' ');

export class CodexChatRunner implements AgentRunner {
  constructor(private readonly options: RunnerOptions) {}

  start(spec: RunSpec, listener: RunListener) {
    const controller = new AbortController();
    const pending: string[] = [];
    let steer: ((text: string) => void) | undefined;
    const finished = this.run(spec, listener, controller.signal, (send) => {
      steer = send;
      for (const text of pending.splice(0)) send(text);
    });
    return {
      send(text: string) {
        if (steer) steer(text);
        else pending.push(text);
      },
      async stop() {
        controller.abort();
        await finished;
      },
    };
  }

  private async run(
    spec: RunSpec,
    listener: RunListener,
    signal: AbortSignal,
    onTurn: (send: (text: string) => void) => void,
  ): Promise<void> {
    let outcome: RunOutcome;
    try {
      if (spec.role === 'worker' && (spec.taskKind !== 'build' || !spec.taskId)) {
        throw new Error('Codex workers currently support build tasks only.');
      }
      const sessionId = spec.resumeSessionId;
      const resumeThreadId = sessionId?.startsWith(CODEX_SESSION_PREFIX)
        ? sessionId.slice(CODEX_SESSION_PREFIX.length)
        : undefined;
      const instructions = await this.options.instructions(spec.role);
      const model = CodexTaskModelSchema.safeParse(spec.model);
      let usage = EMPTY_USAGE;
      const reply = await runCodexChat(this.options.binary, {
        cwd: spec.cwd,
        env: this.options.env,
        prompt: spec.firstMessage,
        ...(model.success ? { model: model.data.slice('codex:'.length) } : {}),
        instructions:
          instructions +
          '\n\n' +
          (spec.role === 'worker' ? WORKER_INSTRUCTIONS : DISPATCHER_INSTRUCTIONS),
        signal,
        timeoutMs: this.options.timeoutMs(spec),
        onTurn,
        onUsage: (value) => {
          usage = value;
        },
        ...(spec.role === 'worker' && spec.taskId
          ? {
              writableRoots: [spec.cwd, this.options.artifactsDir(spec.taskId)],
              approveCommand: (input: Record<string, unknown>) =>
                this.options.approveCommand(spec, input),
            }
          : {}),
        ...(resumeThreadId ? { resumeThreadId } : {}),
        onThread: (threadId) => listener.session(CODEX_SESSION_PREFIX + threadId),
        tools: this.tools(spec),
      });
      outcome = {
        type: 'result',
        subtype: 'success',
        turns: 1,
        costUsd: 0,
        usage,
        ...(spec.role === 'dispatcher' ? { dispatcherReply: reply } : { message: reply }),
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

  private tools(spec: RunSpec): CodexTool[] {
    const unavailable = new Set<ToolName>([
      'approve',
      'reply',
      'set_task_model',
      'start_dev_server',
      'stop_dev_server',
      'attach_image',
      'comment_on_pr',
    ]);
    return toolsByRole[spec.role].flatMap((name) => {
      if (name === 'approve' || unavailable.has(name)) return [];
      const schema = toolInputSchemas[name];
      return [
        {
          name,
          description:
            name === 'create_task'
              ? 'Create a Jarvis build task. Supply a title, self-contained description and optional allowed repository.'
              : this.options.descriptions[name],
          inputSchema: schema.toJSONSchema(),
          call: async (input: unknown) => {
            const parsed = schema.safeParse(input);
            if (!parsed.success) throw new Error(parsed.error.message);
            if (name === 'create_task') {
              const task = parsed.data as ToolInput<'create_task'>;
              if (task.kind === 'ui_check' || task.pr || task.model) {
                throw new Error('Use a build task without a PR reference or model override.');
              }
            }
            return this.options.callTool(spec, name, parsed.data);
          },
        },
      ];
    });
  }
}
