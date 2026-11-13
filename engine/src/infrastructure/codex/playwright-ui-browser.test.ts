import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JarvisConfigSchema } from '@jarvis/shared';
import { PlaywrightUiBrowser } from './playwright-ui-browser.js';

const fake = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  transportClose: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = fake.connect;
    listTools = fake.listTools;
    callTool = fake.callTool;
    close = fake.close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(input: unknown) {
      fake.spawn(input);
    }
    close = fake.transportClose;
  },
}));

let root: string;
let outputDir: string;
let browser: PlaywrightUiBrowser;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'jarvis-browser-'));
  outputDir = join(root, 'screenshots', 'check-1');
  fake.listTools.mockResolvedValue({
    tools: [
      { name: 'browser_navigate', inputSchema: {} },
      { name: 'browser_take_screenshot', inputSchema: {} },
      { name: 'browser_evaluate', inputSchema: {} },
      { name: 'browser_close', inputSchema: {} },
    ],
  });
  fake.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  browser = new PlaywrightUiBrowser({
    config: () => JarvisConfigSchema.parse({ repo: { path: '/repo' } }),
    apiUrl: () => 'http://127.0.0.1:4310',
    protectedPorts: [5433],
    env: { PATH: '/bin', GH_TOKEN: 'must-not-inherit', DATABASE_URL: 'must-not-inherit' },
  });
});
afterEach(async () => {
  await browser.close('r1').catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const call = (tool: string, args = {}) =>
  browser.call({ runId: 'r1', outputDir, tool, arguments: args });

describe('run-scoped Playwright bridge', () => {
  it('lazily starts one pinned process with sanitized env and exposes only approved tools', async () => {
    expect(fake.spawn).not.toHaveBeenCalled();
    const tools = await call('list');
    expect(JSON.stringify(tools)).not.toContain('browser_evaluate');
    await call('browser_navigate', { url: 'http://localhost:5400' });
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    expect(fake.spawn.mock.calls[0]?.[0]).toMatchObject({
      env: { PATH: '/bin' },
      args: expect.arrayContaining([
        '@playwright/mcp@0.0.84',
        '--isolated',
        '--no-webmcp',
        '--blocked-origins',
      ]),
    });
    await expect(call('browser_evaluate')).rejects.toThrow('unavailable');
  });

  it('preserves image content and saves only engine-named screenshot evidence', async () => {
    const content = [{ type: 'image', mimeType: 'image/png', data: 'AQID' }];
    fake.callTool.mockResolvedValueOnce({ content });
    const result = await call('browser_take_screenshot', { filename: '/outside.png' });
    expect(result.content).toEqual(content);
    expect(result.evidence).toHaveLength(1);
    const evidence = result.evidence![0]!;
    expect(evidence).toMatch(/^screenshots\/check-1\/[a-f0-9-]+\.png$/);
    expect(await readFile(join(root, evidence))).toEqual(Buffer.from([1, 2, 3]));
  });

  it('propagates MCP errors and closes transport even if browser close throws', async () => {
    fake.callTool.mockResolvedValueOnce({ content: [], isError: true });
    expect(await call('browser_navigate')).toMatchObject({ isError: true });
    fake.callTool.mockRejectedValueOnce(new Error('MCP disconnected'));
    await expect(browser.close('r1')).rejects.toThrow('disconnected');
    expect(fake.close).toHaveBeenCalled();
    expect(fake.transportClose).toHaveBeenCalled();
    await browser.close('r1');
  });

  it('closes a partially connected process after launch/list failure', async () => {
    fake.listTools.mockRejectedValueOnce(new Error('no browser protocol'));
    await expect(call('list')).rejects.toThrow('protocol');
    expect(fake.transportClose).toHaveBeenCalled();
  });

  it('rejects output directories redirected outside task artifacts', async () => {
    const outside = join(root, 'outside');
    const task = join(root, 'task');
    await mkdir(outside);
    await mkdir(task);
    await symlink(outside, join(task, 'screenshots'));
    outputDir = join(task, 'screenshots', 'check-1');
    await expect(call('list')).rejects.toThrow('leaves task');
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});
