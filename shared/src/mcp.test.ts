import { describe, expect, it } from 'vitest';
import { ApproveResultSchema, toolInputSchemas, toolsByRole, type ToolName } from './mcp.js';

const identityFields = ['taskId', 'threadId', 'role', 'runId'];

const validInputs: Record<ToolName, Record<string, unknown>> = {
  create_task: { title: 'Add page', description: 'Build the page' },
  list_tasks: {},
  cancel_task: { task: 'T-1' },
  send_to_task: { task: 'T-1', message: 'hi' },
  reply: { text: 'hello' },
  report_stage: { stage: 'Verifying' },
  ask_owner: { question: 'Which one?', options: ['a', 'b'] },
  submit_spec_for_approval: { summary: 'spec ready' },
  report_checks: { passed: true, summary: 'all green' },
  report_pr: { number: 3, url: 'https://github.com/o/r/pull/3' },
  log_note: { text: 'note' },
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
