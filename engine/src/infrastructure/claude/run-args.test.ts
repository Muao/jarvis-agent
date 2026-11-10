import { describe, expect, it } from 'vitest';
import { buildRunArgs } from './run-args.js';
import { specOf } from './spec-fixture.js';

const ctx = { agentDir: '/repo/agent', runDir: '/home/runs/R-1' };

const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe('buildRunArgs', () => {
  it('passes the fixed flags of every run (ADR-0003, ADR-0009)', () => {
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

  // ADR-0025: the owner's own plugin, for every role, after the built-in one.
  describe('the owner plugin (ADR-0025)', () => {
    const pluginDirs = (args: string[]) =>
      args.flatMap((arg, i) => (arg === '--plugin-dir' ? [args[i + 1]] : []));
    const withOwner = { ...ctx, ownerPluginDir: '/home/.jarvis/plugin', ownerPluginPresent: true };

    it.each([
      ['dispatcher', specOf({ role: 'dispatcher' })],
      ['worker', specOf({ role: 'worker' })],
      ['ui_check', specOf({ taskKind: 'ui_check' })],
    ])('is loaded after the built-in plugin for a %s run', (_role, spec) => {
      expect(pluginDirs(buildRunArgs(spec, withOwner))).toEqual([
        '/repo/agent',
        '/home/.jarvis/plugin',
      ]);
    });

    it('is left out until the plugin exists', () => {
      expect(
        pluginDirs(buildRunArgs(specOf(), { ...withOwner, ownerPluginPresent: false })),
      ).toEqual(['/repo/agent']);
      expect(pluginDirs(buildRunArgs(specOf(), ctx))).toEqual(['/repo/agent']);
    });
  });

  // A ui_check run's working directory is the pull request's head. `project` and `local` would
  // read `.claude/settings.json` from that tree: it cannot widen permissions (project `allow`
  // rules wait for workspace trust, which a task worktree never has), but its `deny` and `ask`
  // rules apply at once, so a hostile head could refuse the browser and fail every check.
  it('does not read settings out of a pull request’s own tree (ADR-0018)', () => {
    const args = buildRunArgs(specOf({ taskKind: 'ui_check' }), ctx);

    expect(valueOf(args, '--setting-sources')).toBe('user');
    // Our own settings still reach the run; they do not come from the tree.
    expect(valueOf(args, '--settings')).toBe('/home/runs/R-1/settings.json');
  });

  it('keeps project settings for a build task, whose repository is the owner’s', () => {
    expect(valueOf(buildRunArgs(specOf({ taskKind: 'build' }), ctx), '--setting-sources')).toBe(
      'project,local',
    );
  });

  it('ui_check: denies the shell and the editors a check never needs', () => {
    const args = buildRunArgs(specOf({ taskKind: 'ui_check' }), ctx);
    const denied = valueOf(args, '--disallowedTools')?.split(',') ?? [];
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'Edit', 'NotebookEdit']));
    expect(args).not.toContain('--allowedTools');
  });

  it('ui_check: hides the four memory write tools (ADR-0021)', () => {
    const denied = valueOf(
      buildRunArgs(specOf({ taskKind: 'ui_check' }), ctx),
      '--disallowedTools',
    );
    expect(denied?.split(',')).toEqual(
      expect.arrayContaining([
        'mcp__jarvis__note_insight',
        'mcp__jarvis__confirm_insight',
        'mcp__jarvis__contradict_insight',
        'mcp__jarvis__remember_owner',
      ]),
    );
  });

  it('dispatcher: reads files and the web without asking', () => {
    const allowed = valueOf(buildRunArgs(specOf({ role: 'dispatcher' }), ctx), '--allowedTools');
    expect(allowed?.split(',')).toEqual(
      expect.arrayContaining(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']),
    );
  });

  it('build worker: no tool restrictions, no resume by default', () => {
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
