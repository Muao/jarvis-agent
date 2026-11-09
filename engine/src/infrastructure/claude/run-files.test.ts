import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolsByRole } from '@jarvis/shared';
import type { RunContext } from './run-context.js';
import {
  BROWSER_DENIED_TOOLS,
  BROWSER_TOOLS,
  PLAYWRIGHT_BROWSER_VERSION,
  PLAYWRIGHT_MCP,
  playwrightToolName,
  writeRunFiles,
} from './run-files.js';
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
      ui: {
        enabled: false,
        devCommand: 'pnpm dev',
        baseUrl: 'http://127.0.0.1:5173',
        readyPath: '/',
        readyTimeoutSeconds: 90,
        leaseMinutes: 15,
        maxScenarios: 8,
        maxScreenshots: 12,
        maxImageMb: 5,
        attachToPr: true,
        autoApproveComments: false,
        allowedOrigins: [],
        env: {},
        noSandbox: false,
        paths: ['**/*.tsx'],
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

  describe('the UI check (ADR-0014)', () => {
    const uiOn = (overrides: Record<string, unknown> = {}) => {
      const base = ctxOf();
      return ctxOf({
        config: { ...base.config, ui: { ...base.config.ui, enabled: true, ...overrides } },
      });
    };
    const workerSpec = specOf({ screenshotsDir: '/jarvis/tasks/T-1/screenshots' });

    it('adds a pinned, headless Playwright server pointed at the dev server (AC-4)', async () => {
      await writeRunFiles(runDir, workerSpec, uiOn());

      const playwright = json('mcp.json')['mcpServers']?.['playwright'] as {
        command: string;
        args: string[];
      };
      expect(playwright.command).toBe('npx');
      expect(playwright.args).toContain('@playwright/mcp@0.0.84');
      expect(playwright.args).toContain('--headless');
      expect(playwright.args).toContain('--isolated');
      expect(playwright.args).toContain('--no-webmcp');
      expect(playwright.args).not.toContain('--no-sandbox');
      const pairs = (flag: string) => playwright.args[playwright.args.indexOf(flag) + 1];
      expect(pairs('--output-dir')).toBe('/jarvis/tasks/T-1/screenshots');
      expect(pairs('--allowed-origins')).toBe('http://127.0.0.1:5173');
    });

    // An app with a back end is two origins: the page on one port, its API on another. Playwright
    // MCP blocks every origin it was not given, so with only `baseUrl` the first API call died as
    // ERR_BLOCKED_BY_CLIENT and took every logged-in scenario with it (T-5 on quick-blog PR #38).
    it('lets the browser reach the API origins the owner declared (AC-4)', async () => {
      await writeRunFiles(
        runDir,
        workerSpec,
        uiOn({ allowedOrigins: ['http://127.0.0.1:5001', 'http://127.0.0.1:5001/ignored/path'] }),
      );

      const playwright = json('mcp.json')['mcpServers']?.['playwright'] as { args: string[] };
      const origins = playwright.args[playwright.args.indexOf('--allowed-origins') + 1];
      // The app's own origin stays first, and a repeated origin is not listed twice.
      // Semicolons: Playwright MCP's own separator. A comma-joined list is one invalid origin,
      // which blocks every request including the app's own (T-5 run 3).
      expect(origins).toBe('http://127.0.0.1:5173;http://127.0.0.1:5001');
    });

    it('adds --no-sandbox only when the config asks for it (the runtime container)', async () => {
      await writeRunFiles(runDir, workerSpec, uiOn({ noSandbox: true }));
      const playwright = json('mcp.json')['mcpServers']?.['playwright'] as { args: string[] };
      expect(playwright.args).toContain('--no-sandbox');
    });

    it('leaves the browser out while ui.enabled is false (AC-5)', async () => {
      await writeRunFiles(runDir, workerSpec, ctxOf());
      expect(json('mcp.json')['mcpServers']).not.toHaveProperty('playwright');
    });

    it('never gives the dispatcher a browser (AC-6)', async () => {
      await writeRunFiles(runDir, specOf({ role: 'dispatcher' }), uiOn());
      expect(json('mcp.json')['mcpServers']).not.toHaveProperty('playwright');
    });

    it('leaves the browser out for a run with no screenshots directory', async () => {
      await writeRunFiles(runDir, specOf(), uiOn());
      expect(json('mcp.json')['mcpServers']).not.toHaveProperty('playwright');
    });

    it('allows the driving tools and denies page code and uploads (AC-7)', async () => {
      await writeRunFiles(runDir, workerSpec, uiOn());

      const { allow, deny } = permissions();
      expect(allow).toEqual(
        expect.arrayContaining([
          'mcp__playwright__browser_navigate',
          'mcp__playwright__browser_snapshot',
          'mcp__playwright__browser_take_screenshot',
          'mcp__playwright__browser_click',
          'mcp__playwright__browser_console_messages',
          'mcp__playwright__browser_network_requests',
        ]),
      );
      expect(deny).toEqual(
        expect.arrayContaining([
          'mcp__playwright__browser_evaluate',
          'mcp__playwright__browser_run_code_unsafe',
        ]),
      );
      // Choosing a file is an ordinary thing to do in a form, so it is allowed. The line is
      // "did the interface do it", not "is the tool powerful".
      expect(allow).toContain('mcp__playwright__browser_file_upload');
      expect(deny).not.toContain('mcp__playwright__browser_file_upload');
      expect(new Set(allow).size).toBe(allow.length);
    });

    // The subagent's `tools:` front matter is a closed allow-list: a browser tool the engine
    // permits in settings.json is still invisible to `ui-tester` unless named there too. Letting
    // the two lists drift once left a run with a live dev server and an agent that could not
    // open a page (T-4 on quick-blog PR #38).
    it('names every allowed browser tool in the ui-tester front matter (AC-7)', () => {
      const frontMatter = readFileSync(join(REPO_AGENT, 'agents', 'ui-tester.md'), 'utf8')
        .split('---')[1]
        ?.match(/^tools:(.*)$/m)?.[1];
      const granted = (frontMatter ?? '').split(',').map((tool) => tool.trim());

      expect(granted).toEqual(['Read', 'Glob', 'Grep', ...BROWSER_TOOLS.map(playwrightToolName)]);
      for (const denied of BROWSER_DENIED_TOOLS) {
        expect(granted).not.toContain(playwrightToolName(denied));
      }
    });

    // A chromium build belongs to one Playwright revision. The image once installed browsers from
    // playwright 1.64.1 (chromium 1248) while the pinned MCP shipped 1.65.0-alpha (chromium 1252),
    // so the browser was there and still would not launch.
    it('installs chromium from the Playwright release the pinned MCP ships (AC-4)', () => {
      const dockerfile = readFileSync(
        resolve(REPO_AGENT, '..', 'docker', 'runtime', 'Dockerfile'),
        'utf8',
      );

      expect(dockerfile).toContain(`ARG PLAYWRIGHT_VERSION=${PLAYWRIGHT_BROWSER_VERSION}`);
      expect(dockerfile).toContain('playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium');
      expect(PLAYWRIGHT_MCP).toBe('@playwright/mcp@0.0.84');
    });

    it('denies the page-code tools even with the UI check off, and allows no browser tool', async () => {
      await writeRunFiles(runDir, workerSpec, ctxOf());

      const { allow, deny } = permissions();
      expect(allow.filter((rule) => rule.startsWith('mcp__playwright__'))).toEqual([]);
      expect(deny).toContain('mcp__playwright__browser_run_code_unsafe');
    });
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

  describe('worker settings (SEC-01, SEC-02, ADR-0007)', () => {
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
          ui: {
            enabled: false,
            devCommand: 'pnpm dev',
            baseUrl: 'http://127.0.0.1:5173',
            readyPath: '/',
            readyTimeoutSeconds: 90,
            leaseMinutes: 15,
            maxScenarios: 8,
            maxScreenshots: 12,
            maxImageMb: 5,
            attachToPr: true,
            autoApproveComments: false,
            allowedOrigins: [],
            env: {},
            noSandbox: false,
            paths: ['**/*.tsx'],
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
