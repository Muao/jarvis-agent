import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolInputSchemas, toolsByRole, type ToolName } from '@jarvis/shared';

const prompt = readFileSync(
  fileURLToPath(new URL('../../../../agent/prompts/worker.md', import.meta.url)),
  'utf8',
);

describe('agent/prompts/worker.md (ADR-0022)', () => {
  // The engine pushes and opens the PR; a prompt that still teaches the old steps sends the worker
  // down a road that is closed (no token, a denied command) or that answers `tool_retired`.
  it.each(['git push', 'gh pr create', 'report_checks', 'report_pr', 'gh run view'])(
    'does not mention %s',
    (retired) => {
      expect(prompt).not.toContain(retired);
    },
  );

  it('tells the worker to finish through open_pr', () => {
    expect(prompt).toContain('open_pr');
  });

  it('names only Jarvis tools the worker role has', () => {
    const mentioned = (Object.keys(toolInputSchemas) as ToolName[]).filter((name) =>
      new RegExp(`\`(?:mcp__jarvis__)?${name}\`|mcp__jarvis__${name}\\b`).test(prompt),
    );

    expect(mentioned.length).toBeGreaterThan(5);
    const worker: readonly ToolName[] = toolsByRole.worker;
    expect(mentioned.filter((name) => !worker.includes(name))).toEqual([]);
  });
});
