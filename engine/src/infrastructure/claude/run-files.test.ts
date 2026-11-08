import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolsByRole } from '@jarvis/shared';
import type { RunContext } from './run-context.js';
import { writeRunFiles } from './run-files.js';
import { specOf } from './spec-fixture.js';

const REPO_AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../agent');
const read = (path: string) => readFileSync(path, 'utf8');

describe('writeRunFiles', () => {
  let root: string;
  let runDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-run-files-'));
    runDir = join(root, 'runs', 'R-1');
    mkdirSync(runDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ctxOf = (overrides: Partial<RunContext> = {}): RunContext => ({
    agentDir: REPO_AGENT,
    runDir,
    config: {
      repo: { path: '/repo', remote: 'origin', baseBranch: 'main' },
      allowlist: { githubReviewers: [], autoAllowedCommands: ['Bash(pnpm test:*)'] },
      telemetry: {
        enabled: false,
        otlpEndpoint: 'http://127.0.0.1:4318',
        protocol: 'http/protobuf',
      },
    },
    mcpServer: { command: '/usr/bin/node', args: ['--import', 'tsx', '/repo/engine/mcp.ts'] },
    apiUrl: 'http://127.0.0.1:4310',
    connectorSecrets: {},
    ...overrides,
  });
  type Json = Record<string, Record<string, unknown>>;
  const json = (name: string) => JSON.parse(read(join(runDir, name))) as Json;
  const permissions = () =>
    json('settings.json')['permissions'] as { allow: string[]; deny: string[] };

  it('system.md is SOUL.md followed by the role prompt', async () => {
    await writeRunFiles(runDir, specOf({ role: 'worker' }), ctxOf());
    const system = read(join(runDir, 'system.md'));
    const soul = read(join(REPO_AGENT, 'SOUL.md')).trimEnd();
    const prompt = read(join(REPO_AGENT, 'prompts', 'worker.md')).trimEnd();
    expect(system).toBe(`${soul}\n\n${prompt}\n`);

    await writeRunFiles(runDir, specOf({ role: 'dispatcher' }), ctxOf());
    expect(read(join(runDir, 'system.md'))).toContain(
      read(join(REPO_AGENT, 'prompts', 'dispatcher.md')).trimEnd(),
    );
  });

  it('mcp.json starts the Jarvis server with the API url and the run token', async () => {
    await writeRunFiles(runDir, specOf({ runToken: 'tok-123' }), ctxOf());
    expect(json('mcp.json')).toEqual({
      mcpServers: {
        jarvis: {
          command: '/usr/bin/node',
          args: ['--import', 'tsx', '/repo/engine/mcp.ts'],
          env: {
            JARVIS_API_URL: 'http://127.0.0.1:4310',
            JARVIS_RUN_TOKEN: 'tok-123',
            JARVIS_ROLE: specOf({ runToken: 'tok-123' }).role,
          },
        },
      },
    });
    expect(statSync(join(runDir, 'mcp.json')).mode & 0o077).toBe(0);
  });

  it('adds connector servers for workers with ${VAR} substituted, never for the dispatcher', async () => {
    const connectorsFile = join(root, 'servers.json');
    writeFileSync(
      connectorsFile,
      JSON.stringify({
        mcpServers: {
          notion: {
            command: 'npx',
            args: ['notion-mcp'],
            env: { TOKEN: '${NOTION_TOKEN}', X: '${MISSING}' },
          },
        },
      }),
    );
    const ctx = ctxOf({ connectorsFile, connectorSecrets: { NOTION_TOKEN: 'ntn_secret' } });

    await writeRunFiles(runDir, specOf({ role: 'worker' }), ctx);
    expect((json('mcp.json')['mcpServers']?.['notion'] as { env: unknown }).env).toEqual({
      TOKEN: 'ntn_secret',
      X: '',
    });
    expect(Object.keys(json('mcp.json')['mcpServers'] ?? {})).toContain('jarvis');

    await writeRunFiles(runDir, specOf({ role: 'dispatcher' }), ctx);
    expect(Object.keys(json('mcp.json')['mcpServers'] ?? {})).toEqual(['jarvis']);
  });

  it('works without a connectors file', async () => {
    await writeRunFiles(
      runDir,
      specOf(),
      ctxOf({ connectorsFile: join(root, 'missing', 'servers.json') }),
    );
    expect(Object.keys(json('mcp.json')['mcpServers'] ?? {})).toEqual(['jarvis']);
  });

  describe('worker settings (SEC-01, SEC-02, ADR-0009)', () => {
    it('appends the owner allow-list to the base allow rules', async () => {
      await writeRunFiles(runDir, specOf(), ctxOf());
      const { allow } = permissions();
      expect(allow).toContain('Bash(pnpm test:*)');
      expect(allow).toContain('Bash(git commit:*)');
    });

    it('allows its own Jarvis tools but not approve', async () => {
      await writeRunFiles(runDir, specOf(), ctxOf());
      const { allow } = permissions();
      for (const tool of toolsByRole.worker.filter((t) => t !== 'approve')) {
        expect(allow).toContain(`mcp__jarvis__${tool}`);
      }
      expect(allow).not.toContain('mcp__jarvis__approve');
    });

    it('denies force push, delete, merge and pushes to the base branch', async () => {
      await writeRunFiles(runDir, specOf(), ctxOf());
      const { deny } = permissions();
      expect(deny).toEqual(
        expect.arrayContaining([
          'Bash(git push --force:*)',
          'Bash(git push * --delete*)',
          'Bash(gh pr merge:*)',
          'Bash(git push origin main:*)',
          'Bash(git push origin HEAD:main:*)',
          'Bash(git push origin :*)',
        ]),
      );
      expect(new Set(deny).size).toBe(deny.length);
    });

    it('follows the configured remote and base branch', async () => {
      const ctx = ctxOf({
        config: {
          repo: { path: '/repo', remote: 'upstream', baseBranch: 'develop' },
          allowlist: { githubReviewers: [], autoAllowedCommands: [] },
          telemetry: {
            enabled: false,
            otlpEndpoint: 'http://127.0.0.1:4318',
            protocol: 'http/protobuf',
          },
        },
      });
      await writeRunFiles(runDir, specOf(), ctx);
      const { deny } = permissions();
      expect(deny).toContain('Bash(git push upstream develop:*)');
      expect(deny).toContain('Bash(git push upstream HEAD:develop:*)');
      expect(deny).toContain('Bash(git push upstream :*)');
    });
  });

  it('dispatcher settings allow only reading and deny every edit (DSP-03)', async () => {
    await writeRunFiles(runDir, specOf({ role: 'dispatcher' }), ctxOf());
    const { allow, deny } = permissions();
    expect(allow).toEqual([
      'Read',
      'Glob',
      'Grep',
      ...toolsByRole.dispatcher.filter((t) => t !== 'approve').map((t) => `mcp__jarvis__${t}`),
    ]);
    expect(allow).not.toContain('mcp__jarvis__approve');
    expect(deny).toEqual(['Edit', 'Write', 'Bash', 'NotebookEdit']);
  });
});
