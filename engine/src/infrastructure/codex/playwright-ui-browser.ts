import { randomUUID } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UI_BROWSER_TOOLS, type JarvisConfig } from '@jarvis/shared';
import type { UiBrowser } from '../../application/ports/ui-browser.js';
import { playwrightServer } from '../claude/run-files.js';

interface Session {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly tools: Awaited<ReturnType<Client['listTools']>>['tools'];
}

interface Options {
  config(): JarvisConfig;
  apiUrl(): string;
  readonly protectedPorts: readonly number[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** One isolated Playwright MCP process per worker run, reached through authenticated engine tools. */
export class PlaywrightUiBrowser implements UiBrowser {
  private readonly sessions = new Map<string, Promise<Session>>();

  constructor(private readonly options: Options) {}

  private async connect(outputDir: string): Promise<Session> {
    await mkdir(outputDir, { recursive: true });
    const root = await realpath(dirname(dirname(outputDir)));
    const resolved = relative(root, await realpath(outputDir));
    if (resolved.startsWith('..') || isAbsolute(resolved))
      throw new Error('Browser output leaves task artifacts');
    const server = playwrightServer(
      {
        config: this.options.config(),
        apiUrl: this.options.apiUrl(),
        protectedPorts: this.options.protectedPorts,
      },
      outputDir,
    );
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH', 'DISPLAY']) {
      const value = this.options.env[key];
      if (value !== undefined) env[key] = value;
    }
    const transport = new StdioClientTransport({
      command: String(server['command']),
      args: server['args'] as string[],
      env,
      cwd: outputDir,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'jarvis-ui-check', version: '1.0.0' });
    try {
      await client.connect(transport, { timeout: 30_000 });
      const { tools } = await client.listTools({}, { timeout: 15_000 });
      return {
        client,
        transport,
        tools: tools.filter((tool) => UI_BROWSER_TOOLS.some((name) => name === tool.name)),
      };
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  async call(input: Parameters<UiBrowser['call']>[0]) {
    let pending = this.sessions.get(input.runId);
    if (!pending) {
      pending = this.connect(input.outputDir);
      this.sessions.set(input.runId, pending);
    }
    const session = await pending;
    if (input.tool === 'list') {
      return { content: [{ type: 'text', text: JSON.stringify(session.tools) }] };
    }
    if (!session.tools.some((tool) => tool.name === input.tool))
      throw new Error('Browser tool is unavailable');
    const screenshot = input.tool === 'browser_take_screenshot' ? `${randomUUID()}.png` : undefined;
    const args = { ...input.arguments };
    // The worker cannot choose a path outside the task's evidence directory.
    if (screenshot) args['filename'] = join(input.outputDir, screenshot);
    if (input.tool !== 'browser_take_screenshot' && 'filename' in args) {
      args['filename'] = join(input.outputDir, `${randomUUID()}.txt`);
    }
    if (input.tool === 'browser_file_upload') {
      const paths = args['paths'];
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
        throw new Error('Upload paths must name files under task artifacts');
      }
      const root = await realpath(dirname(dirname(input.outputDir)));
      for (const path of paths as string[]) {
        const resolved = relative(root, await realpath(path));
        if (resolved.startsWith('..') || isAbsolute(resolved))
          throw new Error('Upload leaves task artifacts');
      }
    }
    const result = await session.client.callTool({ name: input.tool, arguments: args }, undefined, {
      timeout: 30_000,
    });
    if (!Array.isArray(result.content)) throw new Error('Browser returned unsupported content');
    const evidence: string[] = [];
    if (screenshot && !result.isError) {
      const path = join(input.outputDir, screenshot);
      const image = result.content.find((item) => item.type === 'image');
      if (image?.type === 'image' && typeof image.data === 'string') {
        await writeFile(path, Buffer.from(image.data, 'base64'));
      }
      if ((await readFile(path)).length === 0) throw new Error('Browser produced empty screenshot');
      evidence.push(`screenshots/${basename(input.outputDir)}/${screenshot}`);
    }
    return { content: result.content, evidence, isError: result.isError === true };
  }

  async close(runId: string): Promise<void> {
    const pending = this.sessions.get(runId);
    if (!pending) return;
    let session: Session;
    try {
      session = await pending;
    } catch {
      this.sessions.delete(runId);
      return;
    }
    try {
      // Close Chromium before terminating its MCP parent, including when the caller forgot it.
      const closed = await session.client.callTool(
        { name: 'browser_close', arguments: {} },
        undefined,
        { timeout: 5000 },
      );
      if (closed.isError) throw new Error('Browser did not confirm closure');
    } finally {
      try {
        await session.client.close();
      } finally {
        await session.transport.close();
        this.sessions.delete(runId);
      }
    }
  }
}
