import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolInputSchemas, toolsByRole, type Role, type ToolName } from '@jarvis/shared';
import { ApiCallError, type JarvisApi } from './api-client.js';

/** Model-facing descriptions: what the tool does, when to use it, what it returns. */
export const toolDescriptions: Readonly<Record<ToolName, string>> = {
  create_task:
    'Create a new task from the owner\'s request and start work on it. Use it when the owner asks for a change that needs a worker; write a short title and a self-contained description. Optionally give a `repo` ("owner/name") besides the default one; it must be allow-listed or owned by the configured GitHub account, or creation is rejected with the reason. Returns the created task (id, title, stage).',
  list_tasks:
    'List all tasks with their current stage. Use it to see what is already running before creating, cancelling or messaging a task. Returns an array of tasks.',
  cancel_task:
    'Cancel a task that is no longer wanted. Use it only on the owner\'s request; give a reason when you have one. Returns {"ok": true}.',
  send_to_task:
    'Send a message to a running task\'s worker, for example new instructions or an answer from the owner. Returns {"ok": true}.',
  set_task_target_repo:
    'Point a task at a repo besides the default one, given as "owner/name". The repo must be allow-listed or owned by the configured GitHub account, or this is rejected with the reason; tell the owner why if it is. Returns {"ok": true}.',
  reply:
    'Send a message to the owner in the chat thread. This is how the dispatcher answers; plain assistant text is not shown to the owner. Returns the posted message.',
  remember:
    'Record a durable fact about the owner or their projects (e.g. a repo\'s real slug) so it is not re-guessed or re-asked next time. Appends one bullet to USER.md; never rewrites anything else in it. Returns {"ok": true}.',
  update_config:
    'Apply a partial update to jarvis.config.json, when the owner asks for it in chat. The patch is merged into the current config and validated the same way a manual edit is; an invalid patch is rejected with the reason, nothing is written. `repo.path`, `repo.remote`, `repo.baseBranch`, `repos.allow`, `repos.allowOwnerRepos`, `engine.port`, `engine.claudeBinary`, `ui.devCommand`, `ui.noSandbox` and `ui.paths` can never be changed this way; tell the owner to edit the file themselves for those. Returns the resulting config.',

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
    'Write a short note to the task journal. NOT shown to the owner\'s chat — use it for internal findings and decisions worth keeping (ST-03). Returns {"ok": true}.',
  post_update:
    'Post a short progress update to the owner\'s chat, visible immediately. Works in any stage, including Context and Spec Review where report_stage cannot be called. Use it every few minutes of real work or after a notable step, not after every tool call. Returns {"ok": true}.',

  start_dev_server:
    'Start the project\'s dev server for the UI check and get the URL to point the browser at. Takes no arguments: the command, the URL and how long the server lives all come from the owner\'s config. Only works in the Reviewing stage. Returns {"ok": true, "lease": {"baseUrl", "expiresAt"}}, or {"ok": false, "reason", "detail"} where reason is disabled, busy, port_busy, not_ready or exited — read `detail` and report it instead of retrying blindly.',
  stop_dev_server:
    'Stop the dev server you started, as soon as the UI check is done. The lease stops it anyway, so this is courtesy, not cleanup you can forget. Returns {"stopped": true|false}.',
  attach_image:
    'Upload one screenshot and get the markdown to paste into the PR body. `path` is relative to your artifactsDir (for example "screenshots/001-task-card.png") and may not leave it; `alt` is the caption. Returns {"ok": true, "url", "markdown"}, or {"ok": false, "reason"} — on a refusal put the file name as plain text in the PR, never a markdown image that would render broken.',

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
