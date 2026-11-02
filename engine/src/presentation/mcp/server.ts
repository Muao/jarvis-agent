import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolInputSchemas, toolsByRole, type Role, type ToolName } from '@jarvis/shared';
import { ApiCallError, type JarvisApi } from './api-client.js';

/** Model-facing descriptions: what the tool does, when to use it, what it returns. */
export const toolDescriptions: Readonly<Record<ToolName, string>> = {
  create_task:
    "Create a new task from the owner's request and start work on it. Use it when the owner asks for a change that needs a worker; write a short title and a self-contained description. Returns the created task (id, title, stage).",
  list_tasks:
    'List all tasks with their current stage. Use it to see what is already running before creating, cancelling or messaging a task. Returns an array of tasks.',
  cancel_task:
    'Cancel a task that is no longer wanted. Use it only on the owner\'s request; give a reason when you have one. Returns {"ok": true}.',
  send_to_task:
    'Send a message to a running task\'s worker, for example new instructions or an answer from the owner. Returns {"ok": true}.',
  reply:
    'Send a message to the owner in the chat thread. This is how the dispatcher answers; plain assistant text is not shown to the owner. Returns the posted message.',

  report_stage:
    'Report the stage you are entering: Implementing, Verifying or Reviewing. Call it whenever the stage changes so the owner sees progress. Returns {"ok": true}.',
  ask_owner:
    "Ask the owner a question and wait for the answer; optionally offer answer options. Use it when you are blocked or a decision is theirs. Returns the owner's answer.",
  submit_spec_for_approval:
    "Submit the written spec summary for the owner to approve before implementation. Returns the owner's decision, with feedback when rejected.",
  report_checks:
    'Report the result of the project checks (tests, typecheck, lint): passed or not, with a short summary. Returns the recorded result.',
  report_pr:
    'Report the pull request you opened: its number and URL. Call it once after the PR exists. Returns {"ok": true}.',
  log_note:
    'Write a short progress note to the task log, visible to the owner. Use it for noteworthy decisions or findings. Returns {"ok": true}.',

  approve:
    'Permission prompt tool for the Claude CLI: decides whether a tool use is allowed by asking the owner. Not meant to be called by the model.',
};

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const failure = (error: unknown): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: error instanceof ApiCallError ? error.message : 'Jarvis tool call failed unexpectedly.',
    },
  ],
});

export interface JarvisMcpOptions {
  readonly role: Role;
  readonly api: JarvisApi;
}

/** An MCP server that exposes exactly the tools of the caller's role (ADR-0005). */
export function createJarvisMcpServer({ role, api }: JarvisMcpOptions): McpServer {
  const server = new McpServer({ name: 'jarvis', version: '0.0.0' });

  for (const name of toolsByRole[role] as readonly ToolName[]) {
    const inputSchema = toolInputSchemas[name];
    const description = toolDescriptions[name];

    if (name === 'approve') {
      server.registerTool(
        name,
        { description, inputSchema: toolInputSchemas.approve },
        async (input) => {
          try {
            return text(await api.approve(input));
          } catch (error) {
            // Fail closed: the CLI must get a verdict it understands, never a tool error.
            const message = error instanceof ApiCallError ? error.message : 'Approval failed.';
            return text({ behavior: 'deny', message });
          }
        },
      );
      continue;
    }

    const tool = name;
    server.registerTool(name, { description, inputSchema }, async (input: unknown) => {
      try {
        return text(await api.call(tool, input as never));
      } catch (error) {
        return failure(error);
      }
    });
  }
  return server;
}
