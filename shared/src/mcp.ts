import { z } from 'zod';
import { TaskIdSchema } from './common.js';
import type { Role } from './enums.js';

/**
 * Tool inputs (ADR-0005). The caller's identity (run, role, task, thread) comes from the
 * run token, never from arguments, so every schema is strict. `task` in `cancel_task` and
 * `send_to_task` names the *target* of a dispatcher action, not the caller.
 */
export const toolInputSchemas = {
  create_task: z.strictObject({
    title: z.string().min(1),
    description: z.string().min(1),
    /** ADR-0019: the repo to create the task's worktree in, besides the configured default. */
    repo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'must look like "owner/name"')
      .optional(),
  }),
  list_tasks: z.strictObject({}),
  cancel_task: z.strictObject({ task: TaskIdSchema, reason: z.string().min(1).optional() }),
  send_to_task: z.strictObject({ task: TaskIdSchema, message: z.string().min(1) }),
  /** ADR-0019: names the repo (besides the configured default) a task's worktree is created in. */
  set_task_target_repo: z.strictObject({
    task: TaskIdSchema,
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must look like "owner/name"'),
  }),
  reply: z.strictObject({ text: z.string().min(1) }),
  /** ADR-0020: appends one bullet to `## Learned` in USER.md so a fact survives into new threads. */
  remember: z.strictObject({ fact: z.string().min(1) }),
  /**
   * ADR-0020: a partial update to `jarvis.config.json`, merged and validated against
   * `JarvisConfigSchema` before writing. Patches to `repo.*`, `repos.allow`,
   * `repos.allowOwnerRepos`, `engine.*` are always rejected.
   */
  update_config: z.strictObject({ patch: z.record(z.string(), z.unknown()) }),

  report_stage: z.strictObject({
    stage: z.enum(['Implementing', 'Verifying', 'Reviewing']),
    note: z.string().min(1).optional(),
  }),
  ask_owner: z.strictObject({
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(1).optional(),
  }),
  submit_spec_for_approval: z.strictObject({ summary: z.string().min(1) }),
  report_checks: z.strictObject({ passed: z.boolean(), summary: z.string().min(1) }),
  report_pr: z.strictObject({ number: z.number().int().min(1), url: z.url() }),
  log_note: z.strictObject({ text: z.string().min(1) }),
  post_update: z.strictObject({ text: z.string().min(1) }),

  /**
   * ADR-0022. No arguments on purpose: the command, the URL and the lease come from
   * `ui.*` in the config, so a model can neither choose what the engine runs nor how long.
   */
  start_dev_server: z.strictObject({}),
  stop_dev_server: z.strictObject({}),
  /**
   * ADR-0022. `path` is relative to the task's artifacts directory and may not leave it.
   */
  attach_image: z.strictObject({
    path: z.string().min(1),
    alt: z.string().min(1),
  }),

  /**
   * Arguments the Claude CLI passes to `--permission-prompt-tool`. Built by the CLI, not the
   * model, so unknown extra fields are dropped instead of rejected.
   */
  approve: z.object({
    tool_name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    tool_use_id: z.string().min(1).optional(),
  }),
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export type ToolInput<T extends ToolName> = z.infer<(typeof toolInputSchemas)[T]>;

export const toolsByRole = {
  dispatcher: [
    'create_task',
    'list_tasks',
    'cancel_task',
    'send_to_task',
    'set_task_target_repo',
    'reply',
    'remember',
    'update_config',
    'approve',
  ],
  worker: [
    'report_stage',
    'ask_owner',
    'submit_spec_for_approval',
    'report_checks',
    'report_pr',
    'log_note',
    'post_update',
    'start_dev_server',
    'stop_dev_server',
    'attach_image',
    'approve',
  ],
} as const satisfies Record<Role, readonly ToolName[]>;

/** What the CLI expects back from the permission prompt tool. */
export const ApproveResultSchema = z.discriminatedUnion('behavior', [
  z.object({ behavior: z.literal('allow'), updatedInput: z.record(z.string(), z.unknown()) }),
  z.object({ behavior: z.literal('deny'), message: z.string() }),
]);
export type ApproveResult = z.infer<typeof ApproveResultSchema>;
