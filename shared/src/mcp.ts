import { z } from 'zod';
import { TaskIdSchema } from './common.js';
import { EnvironmentPlanSchema } from './environment-plan.js';
import { TaskKindSchema, TaskModelSchema, type Role } from './enums.js';

/**
 * Tool inputs (ADR-0004). The caller's identity (run, role, task, thread) comes from the
 * run token, never from arguments, so every schema is strict. `task` in `cancel_task` and
 * `send_to_task` names the *target* of a dispatcher action, not the caller.
 */
const RepoSlugSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must look like "owner/name"');

/** ADR-0021: one line, at most 300 characters. */
const MemoryFactSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !/[\r\n]/.test(value), 'must be a single line');

/** ADR-0021: `m<N>`, as the engine numbers entries. */
const MemoryIdSchema = z.string().regex(/^m\d+$/, 'must look like "m3"');

/**
 * ADR-0021: a `path:line` (relative, no `..`) or a GitHub URL. Whether the file exists in the
 * task's worktree is the use case's check, not the schema's.
 */
const MemoryCitationSchema = z
  .string()
  .refine(
    (value) =>
      (/^[^\s:]+:\d+$/.test(value) &&
        !value.startsWith('/') &&
        !value.split(/[\\/]/).includes('..')) ||
      (value.startsWith('https://github.com/') && !/\s/.test(value)),
    'must be "path:line" (relative) or an https://github.com/ URL',
  );

/** ADR-0022: one shell command on one line, at most 300 characters. */
const CheckCommandSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !/[\r\n]/.test(value), 'must be a single line');

export const toolInputSchemas = {
  create_task: z.strictObject({
    title: z.string().min(1),
    description: z.string().min(1),
    /** ADR-0012: the repo to create the task's worktree in, besides the configured default. */
    repo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'must look like "owner/name"')
      .optional(),
    /**
     * ADR-0018: `ui_check` only looks at a pull request that already exists — it writes no code and
     * opens no PR. It requires `pr`; `build` (the default) forbids it.
     */
    kind: TaskKindSchema.optional(),
    /** The model the task's worker runs on, when the owner names one; else `models.worker`. */
    model: TaskModelSchema.optional(),
    /**
     * ADR-0018: the pull request a `ui_check` task is about, as a full URL or `owner/name#number`.
     * A bare number means the task's repo (`repo`, else the configured default).
     */
    pr: z.string().min(1).optional(),
  }),
  list_tasks: z.strictObject({}),
  cancel_task: z.strictObject({ task: TaskIdSchema, reason: z.string().min(1).optional() }),
  send_to_task: z.strictObject({ task: TaskIdSchema, message: z.string().min(1) }),
  /** ADR-0012: names the repo (besides the configured default) a task's worktree is created in. */
  set_task_target_repo: z.strictObject({
    task: TaskIdSchema,
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must look like "owner/name"'),
  }),
  /** The owner asked to wait: no worker run of the task starts until `resume_task`. */
  hold_task: z.strictObject({ task: TaskIdSchema, reason: z.string().min(1).optional() }),
  resume_task: z.strictObject({ task: TaskIdSchema }),
  /** The owner asked for another model; it applies from the task's next worker run. */
  set_task_model: z.strictObject({ task: TaskIdSchema, model: TaskModelSchema }),
  reply: z.strictObject({ text: z.string().min(1) }),
  /**
   * ADR-0013 / ADR-0021: writes one owner entry under `## Learned` in USER.md so a fact survives
   * into new threads. With `repo` it applies to that repository only; without, everywhere.
   */
  remember: z.strictObject({ fact: MemoryFactSchema, repo: RepoSlugSchema.optional() }),
  /** ADR-0021: removes one entry, on the owner's request. */
  forget: z.strictObject({ id: MemoryIdSchema }),
  /** ADR-0021: replaces several entries of one scope with one; counters are summed. */
  merge_insights: z.strictObject({
    ids: z.array(MemoryIdSchema).min(2),
    fact: MemoryFactSchema,
  }),
  /** ADR-0021: the whole `## Learned` section, for the memory-review skill. */
  read_memory: z.strictObject({}),
  /**
   * ADR-0013: a partial update to `jarvis.config.json`, merged and validated against
   * `JarvisConfigSchema` before writing. Patches to `repo.*`, `repos.allow`,
   * `repos.allowOwnerRepos`, `repos.allowSelf`, `engine.*` are always rejected.
   */
  update_config: z.strictObject({ patch: z.record(z.string(), z.unknown()) }),

  /**
   * The stage the worker is entering. `Done` is only reachable where the task kind's transition
   * table allows it — a `ui_check` task closes itself from `Reviewing` (ADR-0018), while a `build`
   * task reaches `Done` through the PR watcher and is refused here.
   */
  report_stage: z.strictObject({
    stage: z.enum(['Implementing', 'Reviewing', 'Done']),
    note: z.string().min(1).optional(),
  }),
  ask_owner: z.strictObject({
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(1).optional(),
  }),
  /**
   * ADR-0022: `checkCommands` is the list the engine will run before it opens the PR. When
   * `AGENTS.md` names commands it may only narrow them; otherwise it is the list.
   */
  submit_spec_for_approval: z.strictObject({
    summary: z.string().min(1),
    checkCommands: z.array(CheckCommandSchema).max(8).optional(),
  }),
  /**
   * ADR-0022: the engine runs the approved checks in the worktree, pushes `jarvis/<task-id>` and
   * opens the draft PR. `title` and `body` are required on the first call and ignored once the
   * task has a PR — that rule belongs to the use case, not the schema.
   */
  open_pr: z.strictObject({
    title: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n]/.test(value), 'must be a single line')
      .optional(),
    body: z.string().min(1).max(20_000).optional(),
    /**
     * Frozen commands the worker leaves out of the gate because they ran red on this head and
     * cannot be made green locally; CI judges them. The engine validates every entry.
     */
    skip: z
      .array(
        z.strictObject({
          command: z.string().min(1).max(500),
          reason: z.string().min(10).max(500),
        }),
      )
      .max(20)
      .optional(),
  }),
  /**
   * Retired by ADR-0022 and no longer offered to any role. The schemas stay for one release so the
   * HTTP route can answer an old session with a redirect to `open_pr`.
   */
  report_checks: z.strictObject({ passed: z.boolean(), summary: z.string().min(1) }),
  report_pr: z.strictObject({ number: z.number().int().min(1), url: z.url() }),
  log_note: z.strictObject({ text: z.string().min(1) }),
  post_update: z.strictObject({ text: z.string().min(1) }),

  /**
   * ADR-0021: a new agent entry in the task's repository. Needs one to five citations — the
   * scope, the time and the counters are the engine's, never the model's.
   */
  note_insight: z.strictObject({
    fact: MemoryFactSchema,
    citations: z.array(MemoryCitationSchema).min(1).max(5),
  }),
  /** ADR-0021: ✓ +1 for this task on an entry whose citations still hold. */
  confirm_insight: z.strictObject({ id: MemoryIdSchema }),
  /** ADR-0021: ✗ +1 for this task; the reason goes to the journal, the entry stays. */
  contradict_insight: z.strictObject({ id: MemoryIdSchema, reason: z.string().min(1) }),
  /**
   * ADR-0021: an owner entry from words the owner wrote in this task's thread. The engine accepts
   * it only when `quote` occurs verbatim in an owner message of the thread.
   */
  remember_owner: z.strictObject({
    fact: MemoryFactSchema,
    quote: z.string().min(8),
    everywhere: z.boolean().optional(),
  }),

  /**
   * ADR-0026. The worker says how to bring the project up; the engine runs it in disposable
   * containers. The lease, the limits, the mounts and the network stay the engine's.
   */
  start_dev_server: z.strictObject({ plan: EnvironmentPlanSchema }),
  stop_dev_server: z.strictObject({}),
  /**
   * ADR-0014. `path` is relative to the task's artifacts directory and may not leave it.
   */
  attach_image: z.strictObject({
    path: z.string().min(1),
    alt: z.string().min(1),
  }),

  /**
   * Arguments the Claude CLI passes to `--permission-prompt-tool`. Built by the CLI, not the
   * model, so unknown extra fields are dropped instead of rejected.
   */
  /**
   * ADR-0018: a comment on the task's pull request, posted only after the owner approves it in the
   * thread. The body is the whole comment, markdown included. With `commentId` the body replaces
   * that comment instead of adding another — only a comment this task posted itself, so a stale
   * verdict can be corrected without leaving two reports for a reader to reconcile.
   */
  comment_on_pr: z.strictObject({
    body: z.string().min(1),
    commentId: z.number().int().positive().optional(),
  }),

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
    'hold_task',
    'resume_task',
    'set_task_model',
    'reply',
    'remember',
    'forget',
    'merge_insights',
    'read_memory',
    'update_config',
    'approve',
  ],
  worker: [
    'report_stage',
    'ask_owner',
    'submit_spec_for_approval',
    'open_pr',
    'log_note',
    'post_update',
    'start_dev_server',
    'stop_dev_server',
    'attach_image',
    'comment_on_pr',
    'note_insight',
    'confirm_insight',
    'contradict_insight',
    'remember_owner',
    'approve',
  ],
} as const satisfies Record<Role, readonly ToolName[]>;

/** What the CLI expects back from the permission prompt tool. */
export const ApproveResultSchema = z.discriminatedUnion('behavior', [
  z.object({ behavior: z.literal('allow'), updatedInput: z.record(z.string(), z.unknown()) }),
  z.object({ behavior: z.literal('deny'), message: z.string() }),
]);
export type ApproveResult = z.infer<typeof ApproveResultSchema>;
