import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolInputSchemas, toolsByRole, type Role, type ToolName } from '@jarvis/shared';
import { FORBIDDEN_PATHS } from '../../application/index.js';
import { ApiCallError, type JarvisApi } from './api-client.js';

/** Model-facing descriptions: what the tool does, when to use it, what it returns. */
export const toolDescriptions: Readonly<Record<ToolName, string>> = {
  create_task:
    'Create a new task from the owner\'s request and start work on it. Use it when the owner asks for a change that needs a worker; write a short title and a self-contained description. Optionally give a `repo` ("owner/name") besides the default one; it must be allow-listed or owned by the configured GitHub account, or creation is rejected with the reason. For "check/test the UI of this pull request" pass `kind: "ui_check"` and `pr` (a PR URL, "owner/name#41", or a number together with `repo`): that task only looks at a pull request that already exists — it writes no code and opens no PR. When the owner names a model ("use Opus", "on Fable") pass `model` (fable, opus, sonnet or haiku); otherwise leave it out. Returns the created task (id, title, stage).',
  list_tasks:
    'List all tasks with their current stage. Use it to see what is already running before creating, cancelling or messaging a task. Returns an array of tasks.',
  cancel_task:
    'Cancel a task that is no longer wanted. Use it only on the owner\'s request; give a reason when you have one. Returns {"ok": true}.',
  send_to_task:
    'Send a message to a running task\'s worker, for example new instructions or an answer from the owner. Returns {"ok": true}.',
  set_task_target_repo:
    'Point a task at a repo besides the default one, given as "owner/name". The repo must be allow-listed or owned by the configured GitHub account, or this is rejected with the reason; tell the owner why if it is. Returns {"ok": true}.',
  hold_task:
    'Put a task on hold when the owner asks to wait ("hold on", "don\'t start yet", "почекай"): no worker run of it starts until `resume_task`. A run already in progress is not interrupted. Owner messages to the task keep waiting for it. Returns {"ok": true}.',
  resume_task:
    'Resume a task that is on hold, when the owner says to go on; queued work starts as soon as a worker slot is free. Returns {"ok": true}.',
  set_task_model:
    'Switch the model a task\'s worker runs on (fable, opus, sonnet or haiku) when the owner asks for it. It applies from the next worker run; a run in progress keeps its model. Returns {"ok": true}.',
  reply:
    'Send a message to the owner in the chat thread. This is how the dispatcher answers; plain assistant text is not shown to the owner. Returns the posted message.',
  remember:
    'Record a durable fact about the owner or their projects (e.g. a repo\'s real slug) so it is not re-guessed or re-asked next time. Writes one owner entry under `## Learned` in USER.md; never rewrites anything else in it. Pass `repo` ("owner/name") for a fact about one repository only; without it the fact applies everywhere. Returns {"ok": true, "id"}.',
  forget:
    'Remove one memory entry by its id (for example "m7"), only when the owner asks. The file is backed up first. Returns {"ok": true}.',
  merge_insights:
    'Replace two or more memory entries of the same repository (or all unscoped) with one entry carrying `fact`; the confirmation counters are summed and the earliest date is kept. Use it when the owner agrees that entries are duplicates. Refused when the ids are from different scopes. Returns {"ok": true, "id"} of the new entry.',
  read_memory:
    'Return the whole `## Learned` section of USER.md — every entry of every repository, with ids, dates and counters. Your prompt carries only the owner\'s entries; use this to review or tidy the memory. Returns {"text"}.',
  update_config:
    'Apply a partial update to jarvis.config.json, when the owner asks for it in chat. The patch is merged into the current config and validated the same way a manual edit is; an invalid patch is rejected with the reason, nothing is written. ' +
    // One source of truth: the list the use case actually enforces.
    `${FORBIDDEN_PATHS.map((path) => `\`${path}\``).join(', ')} can never be changed this way; ` +
    'tell the owner to edit the file themselves for those. Returns the resulting config.',

  report_stage:
    'Report the stage you are entering: Implementing, Reviewing, or Done (the engine sets Verifying and PR Open itself when you call open_pr). Call it whenever the stage changes so the owner sees progress. `Done` closes the task and only a UI-check task may use it — it never opens a pull request, so nothing else would ever close it; for a task that does open one, the engine closes it when the pull request is done and `Done` here is refused. Returns {"ok": true}.',
  ask_owner:
    "Ask the owner a question and wait for the answer; optionally offer answer options. Use it when you are blocked or a decision is theirs. Returns the owner's answer.",
  submit_spec_for_approval:
    'Submit the written spec summary for the owner to approve before implementation. The engine fixes the check commands it will run before opening your pull request: those in the repository\'s AGENTS.md, which `checkCommands` may only narrow (leave some out, never add), or — when AGENTS.md names none — the `checkCommands` you pass (the commands you recorded in context.md). The owner sees the list on the card and approval freezes it. Returns {"cardId"}, or {"ok": false, "reason": "checks_required" | "checks_not_in_agents_md", "detail"} — nothing was submitted; fix the list and call again, or ask_owner when there is no command to run.',
  open_pr:
    'Finish the task: the engine runs the owner-approved checks on your last commit and, only when they all pass, pushes your branch and opens the draft pull request. You cannot push or open a PR yourself. Commit everything first. Pass `title` (one line) and `body` (markdown: What, Sources, Open questions, screenshots — the engine adds the Checks section) the first time; later calls (a fix round) take no arguments and push your new commits to the same PR. `skip` ([{command, reason}]) leaves out a frozen command that ran red on this very commit and cannot be made green here (for example it needs a service only CI has); CI judges it and the PR says so. The call can take several minutes while the checks run. Returns {"ok": true, "number", "url", "headSha", "created"} — then write result.md. Otherwise {"ok": false, "reason", "detail"}: `dirty_tree` — commit the files in `files`, then call again; `no_commits` — commit your work; `ui_check_required` — the diff touches the UI files in `files` and no UI check has run: report_stage Reviewing, do the UI check, then call again; `checks_failed` — read the `tail` of each failing result and the full log at `logPath` (under your artifactsDir), fix the cause, commit and call again (`attempt` of `max` retries used; do not weaken tests); `checks_exhausted` — the task has failed, stop; `checks_unavailable` — a command could not be started (not counted against your retries): tell the owner; `no_checks_declared` — ask_owner which commands to run; `push_rejected` — do not rewrite history: merge or rebase onto the remote branch, commit and call again; `host_error`, `host_unconfigured`, `repo_unknown` — report it to the owner, do not retry blindly; `skip_not_allowed` — a skipped command is not in the frozen list or has not run red on this commit; nothing ran, fix `skip` and call again; `wrong_stage`, `already_running`, `title_and_body_required` — read `detail`.',
  report_checks:
    'Retired: the engine runs the checks itself now. Commit, then call open_pr. Not offered to new sessions.',
  report_pr:
    'Retired: the engine opens the pull request itself now. Commit, then call open_pr. Not offered to new sessions.',
  log_note:
    'Write a short note to the task journal. NOT shown to the owner\'s chat — use it for internal findings and decisions worth keeping (ST-03). Returns {"ok": true}.',
  post_update:
    'Post a short progress update to the owner\'s chat, visible immediately. Works in any stage, including Context and Spec Review where report_stage cannot be called. Use it every few minutes of real work or after a notable step, not after every tool call. Returns {"ok": true}.',

  start_dev_server:
    'Bring the project up for the UI check and get the URL to point the browser at. You pass `plan`: how to run THIS repository, worked out from its own files (see the project-knowledge skill). The engine runs it in disposable containers — your commands never run on the host — from a copy of the task\'s sources mounted at /workspace. `plan` = {"image"?: public image for the project\'s commands (default node:22-bookworm), "prepare": [commands run once in the repo root: installs, builds, migrations], "services": [{"name", "image"?: own container from a public image such as mongo:7 or postgres:16, reachable by its name; without "image" the "command" runs in the background next to the app and is reachable on 127.0.0.1, "command"?, "cwd"?, "ready"?: {"tcp": port}}], "app": {"command", "cwd"?, "port", "readyPath"?}, "extraPorts": [other ports the browser must reach, e.g. the API], "env": {NAME: "value" | {"generate": true} | {"generate": true, "reveal": true}}}. Rules: the app and anything in extraPorts must listen on 0.0.0.0, not localhost; ports are published on the same numbers on 127.0.0.1; never write a credential — a secret is {"generate": true} and other values refer to it as ${NAME}; never copy values from a .env file. Only works in the Reviewing, Fixing and PR Open stages. A generated value is never shown to you, except one you mark "reveal": true — only for a login the browser has to type (a seeded admin password); it comes back in `revealed` and dies with the check. Returns {"ok": true, "lease": {"baseUrl", "origins", "expiresAt"}, "revealed"?: {NAME: value}}, or {"ok": false, "reason", "detail", "step"?, "exitCode"?} where reason is disabled, busy, docker_unavailable, invalid_plan, port_busy, step_failed, not_ready, exited, attempts_exhausted or untrusted_head. On step_failed, not_ready, exited, port_busy or invalid_plan read `detail`, fix the plan and call again; on the others stop and report `detail`.',
  stop_dev_server:
    'Stop the environment you started, as soon as the UI check is done. The lease stops it anyway, so this is courtesy, not cleanup you can forget. Returns {"stopped": true|false}.',
  attach_image:
    'Upload one screenshot and get the markdown to paste into the PR body. `path` is relative to your artifactsDir (for example "screenshots/001-task-card.png") and may not leave it; `alt` is the caption. Returns {"ok": true, "url", "markdown"}, or {"ok": false, "reason"} — on a refusal put the file name as plain text in the PR, never a markdown image that would render broken.',

  comment_on_pr:
    'Comment on the task\'s pull request — the UI-check report, for example. The owner is asked first: a permission card appears in the thread and this waits for their answer, so nothing reaches GitHub unapproved, and every call asks again. Pass `commentId` to replace one of your earlier comments instead of adding another — that is how you correct a verdict you already published, rather than leaving the stale one above the new one; the id comes from the `url` of the comment you posted (the number after `#issuecomment-`), and only this task\'s own comments can be replaced. Returns {"ok": true, "url"} when written, or {"ok": false, "reason"} when the owner declined, the task has no PR, the id is not yours, or GitHub refused; on a refusal keep the report in the thread and do not retry.',
  note_insight:
    'Record something you learned about this repository that a later task will need: a convention, a command, a pitfall. Before calling it, ask whether it would plausibly come up again in a different task — a one-off is not written. Give `fact` as one line of at most 300 characters ("When X, do Y" where it fits) and one to five `citations`: a relative `path:line` in the repository that shows it, or an https://github.com/ URL of the review comment it came from; a `path:line` must name a file that exists in your worktree, and a fact you cannot cite is not written. The entry is scoped to this task\'s repository; the engine adds the time, the task and the counters. Returns {"ok": true, "id"}.',
  confirm_insight:
    'Say that a memory entry from your prompt applied in this task and what it cites still holds (✓ +1). Open what it cites first. The same task counts once per entry. Returns {"ok": true, "confirmed", "counted"}; `counted` is false when this task had already confirmed it.',
  contradict_insight:
    'Say that a memory entry is wrong or stale: the code says the opposite or what it cites is gone (✗ +1). Do not follow the entry; give the `reason`. The entry stays in the file for the owner to review, and its text is never changed; when you can see what is true now, write it as a new `note_insight`. The same task counts once per entry. Returns {"ok": true, "contradicted", "counted"}.',
  remember_owner:
    'Record a standing preference the owner stated in this task\'s thread — "remember …", a comment on the spec, an answer that reads as a rule. `quote` must be the owner\'s own words, copied verbatim from their message (at least 8 characters); it is checked against the thread, and your own text or a review comment is rejected. The entry applies to this task\'s repository; pass `everywhere: true` only when the owner said so in as many words ("always", "in all projects"). Returns {"ok": true, "id"}.',
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

/** An MCP server that exposes exactly the tools of the caller's role (ADR-0004). */
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
