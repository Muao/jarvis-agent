import { describe, expect, it } from 'vitest';
import {
  CLAUDE_AI_CONNECTORS,
  claudeAiAllowRules,
  claudeAiDenyRules,
  usesClaudeAiConnectors,
} from './claude-ai-connectors.js';
import { buildRunArgs } from './run-args.js';
import { buildDispatcherSettings } from './run-files.js';
import { specOf } from './spec-fixture.js';

const ctx = { agentDir: '/repo/agent', runDir: '/home/runs/R-1' };
const valueOf = (args: string[], flag: string): string[] =>
  (args[args.indexOf(flag) + 1] ?? '').split(',');

// A word in a tool name that changes, sends or creates something. `read` lists none of them.
const CHANGES =
  /create|update|delete|send|schedule|move|trash|share(?!d)|copy|upload|restore|resolve|cancel|spawn|stop|add_|set-|duplicate|convert|complete|link-/;

describe('claude.ai connectors (ADR-0027)', () => {
  it('lists no tool that changes anything as readable, and no tool twice', () => {
    for (const { read, other } of Object.values(CLAUDE_AI_CONNECTORS)) {
      expect(read.filter((tool) => CHANGES.test(tool))).toEqual([]);
      expect(new Set([...read, ...other]).size).toBe(read.length + other.length);
    }
  });

  it('allows the read tools of the selected connectors only', () => {
    const allow = claudeAiAllowRules(['notion', 'google_docs']);

    expect(allow).toContain('mcp__claude_ai_Notion__notion-fetch');
    expect(allow).toContain('mcp__claude_ai_Google_Docs__read_doc');
    expect(allow.some((rule) => rule.includes('Slack') || rule.includes('Drive'))).toBe(false);
    expect(allow).not.toContain('mcp__claude_ai_Notion__notion-create-pages');
  });

  it('denies the other tools of a selected connector and every other connector whole', () => {
    const deny = claudeAiDenyRules(['notion', 'slack']);

    expect(deny).toContain('mcp__claude_ai_Notion__notion-update-page');
    expect(deny).toContain('mcp__claude_ai_Slack__slack_send_message');
    expect(deny).toContain('mcp__claude_ai_Google_Drive');
    expect(deny).toContain('mcp__claude_ai_Gmail');
    expect(deny).not.toContain('mcp__claude_ai_Notion');
    expect(deny).not.toContain('mcp__claude_ai_Slack__slack_read_thread');
  });

  it('adds no rule when nothing is selected', () => {
    expect(claudeAiAllowRules([])).toEqual([]);
    expect(claudeAiDenyRules([])).toEqual([]);
  });

  it('is never used by a ui_check run', () => {
    expect(usesClaudeAiConnectors(['notion'], 'build')).toBe(true);
    expect(usesClaudeAiConnectors(['notion'], 'ui_check')).toBe(false);
    expect(usesClaudeAiConnectors([], 'build')).toBe(false);
    expect(usesClaudeAiConnectors(undefined, 'build')).toBe(false);
  });

  describe('run arguments', () => {
    const withConnectors = { ...ctx, claudeAiConnectors: ['notion', 'slack'] as const };

    it('leaves strict mode and reads the user settings source when a connector is listed', () => {
      const args = buildRunArgs(specOf(), withConnectors);

      expect(args).not.toContain('--strict-mcp-config');
      expect(valueOf(args, '--setting-sources')).toEqual(['user', 'project', 'local']);
      // The run's own servers still come from its mcp.json.
      expect(valueOf(args, '--mcp-config')).toEqual(['/home/runs/R-1/mcp.json']);
    });

    it('keeps a ui_check run strict and on the user source alone', () => {
      const args = buildRunArgs(specOf({ taskKind: 'ui_check' }), withConnectors);

      expect(args).toContain('--strict-mcp-config');
      expect(valueOf(args, '--setting-sources')).toEqual(['user']);
      expect(args.join(' ')).not.toContain('claude_ai');
    });

    it('gives the dispatcher the read tools and denies it the rest', () => {
      const args = buildRunArgs(specOf({ role: 'dispatcher' }), withConnectors);

      expect(valueOf(args, '--allowedTools')).toContain('mcp__claude_ai_Slack__slack_read_thread');
      expect(valueOf(args, '--disallowedTools')).toEqual(
        expect.arrayContaining([
          'Bash',
          'mcp__claude_ai_Slack__slack_send_message',
          'mcp__claude_ai_Gmail',
        ]),
      );
    });

    it('changes nothing for a dispatcher without connectors', () => {
      const args = buildRunArgs(specOf({ role: 'dispatcher' }), ctx);

      expect(args).toContain('--strict-mcp-config');
      expect(valueOf(args, '--disallowedTools')).toEqual(['Edit', 'Write', 'Bash', 'NotebookEdit']);
    });
  });

  it('writes the same rules into the dispatcher settings', () => {
    const { permissions } = buildDispatcherSettings({ claudeAiConnectors: ['google_drive'] }) as {
      permissions: { allow: string[]; deny: string[] };
    };

    expect(permissions.allow).toContain('mcp__claude_ai_Google_Drive__read_file_content');
    expect(permissions.deny).toContain('mcp__claude_ai_Google_Drive__trash_file');
    expect(permissions.deny).toContain('mcp__claude_ai_Notion');
  });
});
