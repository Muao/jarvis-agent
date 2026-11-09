import { join } from 'node:path';
import { toolsByRole } from '@jarvis/shared';
import type { RunSpec } from '../../application/index.js';
import type { RunContext } from './run-context.js';

/** Tools the dispatcher may use without asking: its own MCP tools and read-only file tools (DSP-03). */
const DISPATCHER_READ_TOOLS = ['Read', 'Glob', 'Grep'];
const DISPATCHER_DENIED_TOOLS = ['Edit', 'Write', 'Bash', 'NotebookEdit'];

export const mcpToolName = (tool: string): string => `mcp__jarvis__${tool}`;

/** The argv of one `claude` process (ADR-0003, ADR-0009). The prompt itself goes over stdin. */
export function buildRunArgs(
  spec: RunSpec,
  ctx: Pick<RunContext, 'agentDir' | 'runDir'>,
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
