import { join } from 'node:path';
import { toolsByRole } from '@jarvis/shared';
import type { RunSpec } from '../../application/index.js';
import type { RunContext } from './run-context.js';

/** Tools the dispatcher may use without asking: its own MCP tools and read-only file tools (DSP-03). */
const DISPATCHER_READ_TOOLS = ['Read', 'Glob', 'Grep'];
const DISPATCHER_DENIED_TOOLS = ['Edit', 'Write', 'Bash', 'NotebookEdit'];

/**
 * ADR-0018: a `ui_check` worker stands in a pull request's head, whose files (`CLAUDE.md`
 * included) Claude Code reads as instructions. The worker writes no code and runs no checks, so it
 * needs no shell and no editor — with these denied, the worst an injected instruction can do is
 * skew a report the owner reads anyway, not open a shell. The diff it reads is precomputed into
 * `.jarvis/` by the engine (GitWorktreeManager), and the head's code runs only inside
 * `start_dev_server`. `Write` stays: context.md and result.md are the worker's to write.
 */
const UI_CHECK_DENIED_TOOLS = ['Bash', 'Edit', 'NotebookEdit'];

/**
 * ADR-0021: a `ui_check` task reads the memory and writes none. The use cases refuse these too;
 * hiding them keeps the model from even trying.
 */
const UI_CHECK_HIDDEN_MEMORY_TOOLS = [
  'note_insight',
  'confirm_insight',
  'contradict_insight',
  'remember_owner',
];

export const mcpToolName = (tool: string): string => `mcp__jarvis__${tool}`;

/** The argv of one `claude` process (ADR-0003, ADR-0009). The prompt itself goes over stdin. */
export function buildRunArgs(
  spec: RunSpec,
  ctx: Pick<RunContext, 'agentDir' | 'runDir' | 'ownerPluginDir' | 'ownerPluginPresent'>,
): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    ...(spec.resumeSessionId ? ['--resume', spec.resumeSessionId] : []),
    '--model',
    spec.model,
    '--max-turns',
    String(spec.maxTurns),
    '--max-budget-usd',
    String(spec.maxBudgetUsd),
    '--plugin-dir',
    ctx.agentDir,
    // ADR-0025: the owner's own plugin, for every role, after the built-in one.
    ...(ctx.ownerPluginDir !== undefined && ctx.ownerPluginPresent === true
      ? ['--plugin-dir', ctx.ownerPluginDir]
      : []),
    '--setting-sources',
    // ADR-0018: a `ui_check` run's working directory is a pull request's head, which may be
    // someone else's. `project` and `local` read `.claude/settings.json` from exactly there. They
    // cannot raise permissions — project `allow` rules wait for workspace trust and a task
    // worktree is never trusted — but `deny` and `ask` apply at once, so a hostile head could
    // refuse the browser and turn every check into `inconclusive`. The owner's own user settings
    // stay; only the checked-out tree loses its vote.
    spec.taskKind === 'ui_check' ? 'user' : 'project,local',
    '--mcp-config',
    join(ctx.runDir, 'mcp.json'),
    '--strict-mcp-config',
    '--permission-prompt-tool',
    mcpToolName('approve'),
    '--settings',
    join(ctx.runDir, 'settings.json'),
    '--append-system-prompt-file',
    join(ctx.runDir, 'system.md'),
  ];
  if (spec.role === 'worker' && spec.taskKind === 'ui_check') {
    args.push(
      '--disallowedTools',
      [...UI_CHECK_DENIED_TOOLS, ...UI_CHECK_HIDDEN_MEMORY_TOOLS.map(mcpToolName)].join(','),
    );
  }
  if (spec.role === 'dispatcher') {
    args.push(
      '--allowedTools',
      [...toolsByRole.dispatcher.map(mcpToolName), ...DISPATCHER_READ_TOOLS].join(','),
      '--disallowedTools',
      DISPATCHER_DENIED_TOOLS.join(','),
    );
  }
  return args;
}
