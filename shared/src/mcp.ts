import { z } from 'zod';
import { TaskIdSchema } from './common.js';
import type { Role } from './enums.js';

/**
 * Tool inputs (ADR-0005). The caller's identity (run, role, task, thread) comes from the
 * run token, never from arguments, so every schema is strict. `task` in `cancel_task` and
 * `send_to_task` names the *target* of a dispatcher action, not the caller.
 */
export const toolInputSchemas = {
  create_task: z.strictObject({ title: z.string().min(1), description: z.string().min(1) }),
  list_tasks: z.strictObject({}),
  cancel_task: z.strictObject({ task: TaskIdSchema, reason: z.string().min(1).optional() }),
  send_to_task: z.strictObject({ task: TaskIdSchema, message: z.string().min(1) }),
  reply: z.strictObject({ text: z.string().min(1) }),

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
  dispatcher: ['create_task', 'list_tasks', 'cancel_task', 'send_to_task', 'reply', 'approve'],
  worker: [
    'report_stage',
    'ask_owner',
    'submit_spec_for_approval',
    'report_checks',
    'report_pr',
    'log_note',
    'approve',
  ],
} as const satisfies Record<Role, readonly ToolName[]>;

/** What the CLI expects back from the permission prompt tool. */
export const ApproveResultSchema = z.discriminatedUnion('behavior', [
  z.object({ behavior: z.literal('allow'), updatedInput: z.record(z.string(), z.unknown()) }),
  z.object({ behavior: z.literal('deny'), message: z.string() }),
]);
export type ApproveResult = z.infer<typeof ApproveResultSchema>;
