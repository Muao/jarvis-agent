import { describe, expect, it } from 'vitest';
import { ApproveResultSchema, toolInputSchemas, toolsByRole, type ToolName } from './mcp.js';

const identityFields = ['taskId', 'threadId', 'role', 'runId'];

const validInputs: Record<ToolName, Record<string, unknown>> = {
  create_task: { title: 'Add page', description: 'Build the page', repo: 'owner/name' },
  list_tasks: {},
  cancel_task: { task: 'T-1' },
  send_to_task: { task: 'T-1', message: 'hi' },
  set_task_target_repo: { task: 'T-1', repo: 'owner/name' },
  reply: { text: 'hello' },
  remember: { fact: 'the QuickBlog repo is burnjohn/quick-blog' },
  update_config: { patch: { limits: { stallMinutes: 1 } } },
  report_stage: { stage: 'Verifying' },
  ask_owner: { question: 'Which one?', options: ['a', 'b'] },
  submit_spec_for_approval: { summary: 'spec ready' },
  report_checks: { passed: true, summary: 'all green' },
  report_pr: { number: 3, url: 'https://github.com/o/r/pull/3' },
  log_note: { text: 'note' },
  post_update: { text: 'ran the suite, 2 failures, fixing now' },
  start_dev_server: {},
  stop_dev_server: {},
  attach_image: { path: 'screenshots/001-task-card.png', alt: 'the task card' },
  comment_on_pr: { body: '## UI verification\n\nverdict: pass' },
  approve: { tool_name: 'Bash', input: { command: 'ls' } },
};

describe('toolsByRole', () => {
  it('gives every listed tool a schema and a valid sample', () => {
    for (const tools of Object.values(toolsByRole)) {
      for (const name of tools) {
        expect(toolInputSchemas[name].safeParse(validInputs[name]).success, name).toBe(true);
      }
    }
  });

  it('exposes every schema to at least one role, and approve to both', () => {
    const exposed = new Set([...toolsByRole.dispatcher, ...toolsByRole.worker]);
    expect([...exposed].sort()).toEqual(Object.keys(toolInputSchemas).sort());
    expect(toolsByRole.dispatcher).toContain('approve');
    expect(toolsByRole.worker).toContain('approve');
  });

  it('keeps worker and dispatcher capabilities apart', () => {
    expect(toolsByRole.dispatcher).not.toContain('report_pr');
    expect(toolsByRole.worker).not.toContain('create_task');
  });
});

describe('tool input schemas', () => {
  const modelTools = (Object.keys(toolInputSchemas) as ToolName[]).filter((n) => n !== 'approve');

  it.each(modelTools)('%s rejects identity fields', (name) => {
    for (const field of identityFields) {
      const result = toolInputSchemas[name].safeParse({ ...validInputs[name], [field]: 'x' });
      expect(result.success, `${name} accepted ${field}`).toBe(false);
    }
  });

  it('approve tolerates extra CLI fields but never keeps identity fields', () => {
    const extras = Object.fromEntries(identityFields.map((field) => [field, 'x']));
    const parsed = toolInputSchemas.approve.parse({ ...validInputs.approve, ...extras });
    for (const field of identityFields) expect(parsed).not.toHaveProperty(field);
  });

  it('declares no identity field at all', () => {
    for (const schema of Object.values(toolInputSchemas)) {
      for (const field of identityFields) expect(Object.keys(schema.shape)).not.toContain(field);
    }
  });

  it('validates task targets and stages', () => {
    expect(toolInputSchemas.cancel_task.safeParse({ task: '12' }).success).toBe(false);
    expect(toolInputSchemas.report_stage.safeParse({ stage: 'Done' }).success).toBe(false);
  });
});

describe('ApproveResultSchema', () => {
  it('accepts the two shapes the CLI expects', () => {
    expect(
      ApproveResultSchema.safeParse({ behavior: 'allow', updatedInput: { command: 'ls' } }).success,
    ).toBe(true);
    expect(ApproveResultSchema.safeParse({ behavior: 'deny', message: 'no' }).success).toBe(true);
    expect(ApproveResultSchema.safeParse({ behavior: 'allow' }).success).toBe(false);
  });
});

describe('create_task (ADR-0018)', () => {
  const base = { title: 'Check PR 41', description: 'Walk the UI of PR 41' };

  it('accepts a ui_check task with a pull request', () => {
    expect(
      toolInputSchemas.create_task.safeParse({
        ...base,
        kind: 'ui_check',
        pr: 'https://github.com/o/r/pull/41',
      }).success,
    ).toBe(true);
  });

  it('accepts a plain build task with neither field', () => {
    expect(toolInputSchemas.create_task.safeParse(base).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(
      toolInputSchemas.create_task.safeParse({ ...base, kind: 'ui-check' }).success,
    ).toBe(false);
  });
});

describe('comment_on_pr (ADR-0018)', () => {
  it('takes a body and nothing else: the PR comes from the task, not the model', () => {
    expect(toolInputSchemas.comment_on_pr.safeParse({ body: 'hi' }).success).toBe(true);
    expect(toolInputSchemas.comment_on_pr.safeParse({ body: '' }).success).toBe(false);
    expect(
      toolInputSchemas.comment_on_pr.safeParse({ body: 'hi', pr: 41 }).success,
    ).toBe(false);
  });
});
