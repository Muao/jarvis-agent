import { describe, expect, it } from 'vitest';
import { ApproveResultSchema, toolInputSchemas, toolsByRole, type ToolName } from './mcp.js';

const identityFields = ['taskId', 'threadId', 'role', 'runId'];

const validInputs: Record<ToolName, Record<string, unknown>> = {
  create_task: { title: 'Add page', description: 'Build the page', repo: 'owner/name' },
  list_tasks: {},
  cancel_task: { task: 'T-1' },
  send_to_task: { task: 'T-1', message: 'hi' },
  set_task_target_repo: { task: 'T-1', repo: 'owner/name' },
  hold_task: { task: 'T-1' },
  resume_task: { task: 'T-1' },
  set_task_model: { task: 'T-1', model: 'opus' },
  reply: { text: 'hello' },
  remember: { fact: 'the QuickBlog repo is burnjohn/quick-blog', repo: 'burnjohn/quick-blog' },
  forget: { id: 'm3' },
  merge_insights: { ids: ['m3', 'm4'], fact: 'Dates go through formatDate().' },
  read_memory: {},
  update_config: { patch: { limits: { stallMinutes: 1 } } },
  report_stage: { stage: 'Reviewing' },
  ask_owner: { question: 'Which one?', options: ['a', 'b'] },
  submit_spec_for_approval: { summary: 'spec ready' },
  open_pr: { title: 'Add page', body: '## What\nA page.' },
  report_checks: { passed: true, summary: 'all green' },
  report_pr: { number: 3, url: 'https://github.com/o/r/pull/3' },
  log_note: { text: 'note' },
  post_update: { text: 'ran the suite, 2 failures, fixing now' },
  start_dev_server: {},
  stop_dev_server: {},
  attach_image: { path: 'screenshots/001-task-card.png', alt: 'the task card' },
  comment_on_pr: { body: '## UI verification\n\nverdict: pass' },
  note_insight: { fact: 'Dates go through formatDate().', citations: ['lib/date.ts:12'] },
  confirm_insight: { id: 'm7' },
  contradict_insight: { id: 'm7', reason: 'lib/date.ts no longer exports formatDate' },
  remember_owner: { fact: 'Keep specs under one page.', quote: 'keep specs under one page' },
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
    // report_checks and report_pr are retired (ADR-0022): schema only, for the redirect.
    const retired = ['report_checks', 'report_pr'];
    expect([...exposed].sort()).toEqual(
      Object.keys(toolInputSchemas)
        .filter((name) => !retired.includes(name))
        .sort(),
    );
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
    expect(toolInputSchemas.report_stage.safeParse({ stage: 'Shipped' }).success).toBe(false);
    // `Done` is in the enum so a ui_check task can close itself (ADR-0018); whether a given task
    // may use it is the transition table's call, not the schema's.
    expect(toolInputSchemas.report_stage.safeParse({ stage: 'Done' }).success).toBe(true);
    expect(toolInputSchemas.report_stage.safeParse({ stage: 'Spec Review' }).success).toBe(false);
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
    expect(toolInputSchemas.create_task.safeParse({ ...base, kind: 'ui-check' }).success).toBe(
      false,
    );
  });
});

describe('comment_on_pr (ADR-0018)', () => {
  it('takes a body and nothing else: the PR comes from the task, not the model', () => {
    expect(toolInputSchemas.comment_on_pr.safeParse({ body: 'hi' }).success).toBe(true);
    expect(toolInputSchemas.comment_on_pr.safeParse({ body: '' }).success).toBe(false);
    expect(toolInputSchemas.comment_on_pr.safeParse({ body: 'hi', pr: 41 }).success).toBe(false);
  });
});

describe('memory tools (ADR-0021)', () => {
  const { note_insight, remember, merge_insights, remember_owner } = toolInputSchemas;
  const fact = 'Dates go through formatDate().';

  it('assigns the dispatcher and worker memory tools to their own role only', () => {
    expect(toolsByRole.dispatcher).toEqual(
      expect.arrayContaining(['remember', 'forget', 'merge_insights', 'read_memory']),
    );
    expect(toolsByRole.worker).toEqual(
      expect.arrayContaining([
        'note_insight',
        'confirm_insight',
        'contradict_insight',
        'remember_owner',
      ]),
    );
    for (const name of [
      'note_insight',
      'confirm_insight',
      'contradict_insight',
      'remember_owner',
    ]) {
      expect(toolsByRole.dispatcher).not.toContain(name);
    }
    for (const name of ['remember', 'forget', 'merge_insights', 'read_memory']) {
      expect(toolsByRole.worker).not.toContain(name);
    }
  });

  it('note_insight takes one to five citations', () => {
    const cite = (n: number) => Array.from({ length: n }, (_, i) => `src/a.ts:${i + 1}`);
    expect(note_insight.safeParse({ fact, citations: [] }).success).toBe(false);
    expect(note_insight.safeParse({ fact, citations: cite(1) }).success).toBe(true);
    expect(note_insight.safeParse({ fact, citations: cite(5) }).success).toBe(true);
    expect(note_insight.safeParse({ fact, citations: cite(6) }).success).toBe(false);
  });

  it.each(['no-line', '/etc/passwd:1', '../x.ts:3', 'a b.ts:3', 'a.ts:x', 'http://github.com/o/r'])(
    'note_insight rejects the citation %s',
    (citation) => {
      expect(note_insight.safeParse({ fact, citations: [citation] }).success).toBe(false);
    },
  );

  it('note_insight accepts a GitHub URL as a citation', () => {
    const citations = ['https://github.com/o/r/pull/41#discussion_r1'];
    expect(note_insight.safeParse({ fact, citations }).success).toBe(true);
  });

  it('note_insight has no scope argument', () => {
    const parsed = note_insight.safeParse({ fact, citations: ['a.ts:1'], repo: 'o/r' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a fact over 300 characters or with a line break', () => {
    expect(remember.safeParse({ fact: 'x'.repeat(300) }).success).toBe(true);
    expect(remember.safeParse({ fact: 'x'.repeat(301) }).success).toBe(false);
    expect(remember.safeParse({ fact: 'two\nlines' }).success).toBe(false);
    expect(note_insight.safeParse({ fact: 'a\rb', citations: ['a.ts:1'] }).success).toBe(false);
  });

  it('remember takes an owner/name repo or none', () => {
    expect(remember.safeParse({ fact, repo: 'o/r' }).success).toBe(true);
    expect(remember.safeParse({ fact, repo: 'not-a-repo' }).success).toBe(false);
  });

  it('merge_insights needs two ids shaped m<N>', () => {
    expect(merge_insights.safeParse({ ids: ['m1'], fact }).success).toBe(false);
    expect(merge_insights.safeParse({ ids: ['m1', 'x2'], fact }).success).toBe(false);
  });

  it('remember_owner needs a quote of eight characters', () => {
    expect(remember_owner.safeParse({ fact, quote: 'short' }).success).toBe(false);
    expect(remember_owner.safeParse({ fact, quote: '12345678', everywhere: true }).success).toBe(
      true,
    );
  });
});

describe('open_pr and checks (ADR-0022)', () => {
  const { open_pr, submit_spec_for_approval, report_stage } = toolInputSchemas;

  it('is a worker tool; the retired tools are offered to nobody', () => {
    expect(toolsByRole.worker).toContain('open_pr');
    expect(toolsByRole.dispatcher).not.toContain('open_pr');
    for (const name of ['report_checks', 'report_pr']) {
      expect(toolsByRole.worker).not.toContain(name);
      expect(toolsByRole.dispatcher).not.toContain(name);
      expect(name in toolInputSchemas).toBe(true);
    }
  });

  it('open_pr accepts skip entries and rejects a reason under 10 characters', () => {
    const entry = { command: 'pnpm test', reason: 'needs Postgres; CI runs it' };
    expect(open_pr.safeParse({ skip: [entry] }).success).toBe(true);
    expect(open_pr.safeParse({ skip: [{ ...entry, reason: 'too short' }] }).success).toBe(false);
    expect(open_pr.safeParse({ skip: [{ ...entry, command: '' }] }).success).toBe(false);
    expect(open_pr.safeParse({ skip: [{ ...entry, extra: 1 }] }).success).toBe(false);
    expect(open_pr.safeParse({ skip: Array(20).fill(entry) }).success).toBe(true);
    expect(open_pr.safeParse({ skip: Array(21).fill(entry) }).success).toBe(false);
  });

  it('open_pr takes no arguments, or a title and a body, and nothing else', () => {
    expect(open_pr.safeParse({}).success).toBe(true);
    expect(open_pr.safeParse({ title: 't', body: 'b' }).success).toBe(true);
    expect(open_pr.safeParse({ base: 'main' }).success).toBe(false);
    expect(open_pr.safeParse({ head: 'x' }).success).toBe(false);
    expect(open_pr.safeParse({ title: 'a'.repeat(200) }).success).toBe(true);
    expect(open_pr.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
    expect(open_pr.safeParse({ title: 'one\ntwo' }).success).toBe(false);
    expect(open_pr.safeParse({ title: '' }).success).toBe(false);
    expect(open_pr.safeParse({ body: 'a'.repeat(20_000) }).success).toBe(true);
    expect(open_pr.safeParse({ body: 'a'.repeat(20_001) }).success).toBe(false);
    expect(open_pr.safeParse({ body: '' }).success).toBe(false);
  });

  it('submit_spec_for_approval bounds checkCommands', () => {
    const summary = 'spec';
    const ok = (checkCommands: unknown) =>
      submit_spec_for_approval.safeParse({ summary, checkCommands }).success;
    expect(submit_spec_for_approval.safeParse({ summary }).success).toBe(true);
    expect(ok([])).toBe(true);
    expect(ok(Array.from({ length: 8 }, (_, i) => `pnpm t${i}`))).toBe(true);
    expect(ok(Array.from({ length: 9 }, (_, i) => `pnpm t${i}`))).toBe(false);
    expect(ok(['x'.repeat(300)])).toBe(true);
    expect(ok(['x'.repeat(301)])).toBe(false);
    expect(ok([''])).toBe(false);
    expect(ok(['a\nb'])).toBe(false);
    expect(ok(['a\rb'])).toBe(false);
  });

  it('report_stage no longer accepts Verifying or PR Open', () => {
    expect(report_stage.safeParse({ stage: 'Verifying' }).success).toBe(false);
    expect(report_stage.safeParse({ stage: 'PR Open' }).success).toBe(false);
    expect(report_stage.safeParse({ stage: 'Reviewing' }).success).toBe(true);
  });
});
