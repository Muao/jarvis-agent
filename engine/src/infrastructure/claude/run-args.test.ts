import { describe, expect, it } from 'vitest';
import { buildRunArgs } from './run-args.js';
import { specOf } from './spec-fixture.js';

const ctx = { agentDir: '/repo/agent', runDir: '/home/runs/R-1' };

const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe('buildRunArgs', () => {
  it('passes the fixed flags of every run (ADR-0004, ADR-0011)', () => {
    const args = buildRunArgs(specOf(), ctx);
    expect(args.slice(0, 6)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
    ]);
    expect(valueOf(args, '--model')).toBe('sonnet');
    expect(valueOf(args, '--max-turns')).toBe('60');
    expect(valueOf(args, '--max-budget-usd')).toBe('3');
    expect(valueOf(args, '--plugin-dir')).toBe('/repo/agent');
    expect(valueOf(args, '--setting-sources')).toBe('project,local');
    expect(valueOf(args, '--mcp-config')).toBe('/home/runs/R-1/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(valueOf(args, '--permission-prompt-tool')).toBe('mcp__jarvis__approve');
    expect(valueOf(args, '--settings')).toBe('/home/runs/R-1/settings.json');
    expect(valueOf(args, '--append-system-prompt-file')).toBe('/home/runs/R-1/system.md');
  });

  it('worker: no tool restrictions, no resume by default', () => {
    const args = buildRunArgs(specOf(), ctx);
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--disallowedTools');
  });

  it('resumes the session when an id is known', () => {
    const args = buildRunArgs(specOf({ resumeSessionId: 'sess-9' }), ctx);
    expect(valueOf(args, '--resume')).toBe('sess-9');
  });

  it('dispatcher: only its MCP tools and read-only tools, no editing (DSP-03)', () => {
    const args = buildRunArgs(specOf({ role: 'dispatcher' }), ctx);
    const allowed = valueOf(args, '--allowedTools')?.split(',') ?? [];
    expect(allowed).toEqual(
      expect.arrayContaining([
        'mcp__jarvis__create_task',
        'mcp__jarvis__list_tasks',
        'mcp__jarvis__cancel_task',
        'mcp__jarvis__send_to_task',
        'mcp__jarvis__reply',
        'Read',
        'Glob',
        'Grep',
      ]),
    );
    expect(allowed.some((tool) => /^(Edit|Write|Bash|NotebookEdit)$/.test(tool))).toBe(false);
    expect(allowed).not.toContain('mcp__jarvis__report_pr');
    expect(valueOf(args, '--disallowedTools')).toBe('Edit,Write,Bash,NotebookEdit');
  });

  it('never carries the prompt or the run token in argv', () => {
    const args = buildRunArgs(specOf({ firstMessage: 'secret prompt' }), ctx);
    expect(args.join(' ')).not.toContain('secret prompt');
    expect(args.join(' ')).not.toContain('token-1');
  });
});
