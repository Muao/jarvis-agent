import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listMcpServers } from './mcp-listing.js';
import { buildMcpConfig } from './run-files.js';
import type { RunContext } from './run-context.js';
import { specOf } from './spec-fixture.js';

const SECRET = 'fake-secret-value-do-not-leak';

describe('listMcpServers', () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-mcp-listing-'));
    file = join(root, 'servers.json');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const config = (uiEnabled: boolean): RunContext['config'] => ({
    repo: { path: '/repo', remote: 'origin', baseBranch: 'main' },
    allowlist: { githubReviewers: [], autoAllowedCommands: [] },
    telemetry: { enabled: false, otlpEndpoint: 'http://127.0.0.1:4318', protocol: 'http/protobuf' },
    ui: {
      enabled: uiEnabled,
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
      paths: [],
    },
  });

  const ctx = (uiEnabled = false) => ({
    config: config(uiEnabled),
    mcpServer: { command: '/usr/bin/node', args: ['--import', 'tsx', 'main.ts'] },
    apiUrl: 'http://127.0.0.1:4310',
    connectorsFile: file,
  });

  it('describes the built-in server for every role and the connectors for workers', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          notion: {
            command: 'npx',
            args: ['-y', '@notionhq/notion-mcp-server'],
            env: { NOTION_TOKEN: '${NOTION_TOKEN}' },
          },
          docs: { type: 'http', url: 'https://mcp.example.com/v1?token=abc#x' },
        },
      }),
    );

    const servers = await listMcpServers(ctx());

    expect(servers.map((s) => s.name)).toEqual(['jarvis', 'notion', 'docs']);
    expect(servers[0]).toMatchObject({
      source: 'builtin',
      roles: ['dispatcher', 'worker', 'ui_check'],
      transport: 'stdio',
      command: '/usr/bin/node',
    });
    expect(servers[0]?.envVars).toEqual(['JARVIS_API_URL', 'JARVIS_ROLE', 'JARVIS_RUN_TOKEN']);
    expect(servers[1]).toMatchObject({
      source: 'connector',
      roles: ['worker', 'ui_check'],
      transport: 'stdio',
      command: 'npx',
      envVars: ['NOTION_TOKEN'],
    });
    expect(servers[2]).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/v1' });
  });

  it('lists Playwright only when the UI check is on', async () => {
    expect((await listMcpServers(ctx(false))).map((s) => s.name)).not.toContain('playwright');
    const on = await listMcpServers(ctx(true));
    expect(on.find((s) => s.name === 'playwright')).toMatchObject({
      source: 'builtin',
      roles: ['worker', 'ui_check'],
      command: 'npx',
    });
  });

  it('never shows a value: not from env, not a literal in args or the url, not a substituted one', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          a: {
            command: 'srv',
            args: [
              '--token',
              SECRET,
              `--api-key=${SECRET}`,
              '--bearer',
              '${TOKEN}',
              '--port',
              '80',
            ],
            env: { GITHUB_TOKEN: SECRET, PLAIN: 'visible-literal' },
          },
          b: { type: 'sse', url: `https://user:${SECRET}@host.example.com/x?key=${SECRET}` },
        },
      }),
    );

    const servers = await listMcpServers(ctx());
    const text = JSON.stringify(servers);

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('visible-literal');
    expect(servers[1]?.args).toEqual([
      '--token',
      '***',
      '--api-key=***',
      '--bearer',
      '${TOKEN}',
      '--port',
      '80',
    ]);
    expect(servers[1]?.envVars).toEqual(['GITHUB_TOKEN', 'PLAIN', 'TOKEN']);
    expect(servers[2]?.url).toBe('https://host.example.com/x');
  });

  it('shows the placeholder, not the secret, when the run would substitute one', async () => {
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { n: { command: 'x', env: { T: '${NOTION_TOKEN}' } } } }),
    );
    const full = {
      ...ctx(),
      agentDir: '/a',
      runDir: '/r',
      connectorSecrets: { NOTION_TOKEN: SECRET },
    };

    const built = JSON.stringify(await buildMcpConfig(specOf({ role: 'worker' }), full));
    const listed = JSON.stringify(await listMcpServers(full));

    expect(built).toContain(SECRET); // the run gets it…
    expect(listed).not.toContain(SECRET); // …the page never does.
  });

  it('lists the built-in anyway when servers.json is missing or broken', async () => {
    expect((await listMcpServers(ctx())).map((s) => s.name)).toEqual(['jarvis']);
    writeFileSync(file, '{ not json');
    expect((await listMcpServers(ctx())).map((s) => s.name)).toEqual(['jarvis']);
  });
});
