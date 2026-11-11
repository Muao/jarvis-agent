import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunEventBody, RunListener, RunSpec } from '../../application/index.js';
import type { RunOutcome } from '../../domain/index.js';
import { ClaudeCliRunner } from './claude-cli-runner.js';
import { createRedactor } from '../config/index.js';
import { specOf } from './spec-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, '../../../../agent');
const FAKE_CLAUDE = resolve(HERE, '../../../test/fake-claude/fake-claude.mjs');

class Recorder implements RunListener {
  readonly events: RunEventBody[] = [];
  readonly sessions: string[] = [];
  readonly exits: RunOutcome[] = [];
  private waiters: Array<() => void> = [];
  private readonly done: Promise<void>;
  private resolveDone: () => void = () => {};

  constructor() {
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  async event(body: RunEventBody): Promise<void> {
    this.events.push(body);
    this.waiters.forEach((w) => w());
  }
  async session(id: string): Promise<void> {
    this.sessions.push(id);
  }
  async exit(outcome: RunOutcome): Promise<void> {
    this.exits.push(outcome);
    this.resolveDone();
  }

  exited(): Promise<void> {
    return this.done;
  }
  async untilEvent(kind: RunEventBody['kind'], text?: string): Promise<void> {
    const seen = () =>
      this.events.some(
        (e) => e.kind === kind && (text === undefined || JSON.stringify(e.payload).includes(text)),
      );
    while (!seen()) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}

describe('ClaudeCliRunner (against the fake binary)', () => {
  let home: string;
  let api: Server | undefined;
  const received: Array<{ url: string; auth: string | undefined; body: string }> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jarvis-runner-'));
    received.length = 0;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => (api ? api.close(() => resolve()) : resolve()));
    api = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const runnerFor = (
    scenario: string,
    options: { binary?: string; apiUrl?: string; killGraceMs?: number } = {},
  ) =>
    new ClaudeCliRunner({
      binary: options.binary ?? FAKE_CLAUDE,
      envSource: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'sk-ant-leak' },
      extraEnv: { JARVIS_FAKE_SCENARIO: scenario },
      redact: createRedactor([]),
      ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
      contextFor: (spec: RunSpec) => ({
        agentDir: AGENT_DIR,
        runDir: join(home, 'runs', spec.runId),
        config: {
          repo: { path: home, remote: 'origin', baseBranch: 'main' },
          allowlist: { githubReviewers: [], autoAllowedCommands: [] },
          telemetry: {
            enabled: false,
            otlpEndpoint: 'http://127.0.0.1:4318',
            protocol: 'http/protobuf',
          },
          ui: {
            enabled: false,
            defaultImage: 'node:22-bookworm',
            prepareTimeoutSeconds: 600,
            maxStartAttempts: 3,
            readyTimeoutSeconds: 90,
            leaseMinutes: 15,
            maxScenarios: 8,
            maxScreenshots: 12,
            maxImageMb: 5,
            attachToPr: true,
            autoApproveComments: false,
            noSandbox: false,
            paths: ['**/*.tsx'],
          },
        },
        mcpServer: { command: process.execPath, args: ['mcp.js'] },
        apiUrl: options.apiUrl ?? 'http://127.0.0.1:1',
        connectorSecrets: {},
      }),
    });

  const run = async (scenario: string, spec: Partial<RunSpec> = {}) => {
    const rec = new Recorder();
    runnerFor(scenario).start(specOf({ cwd: home, ...spec }), rec);
    await rec.exited();
    return rec;
  };

  it('ok run: ordered events, session id and a completed outcome', async () => {
    const rec = await run('ok');
    expect(rec.kinds()).toEqual(['system', 'text', 'result']);
    expect(rec.sessions).toEqual(['fake-session-1', 'fake-session-1']);
    expect(rec.exits).toEqual([
      {
        type: 'result',
        subtype: 'success',
        message: 'All done',
        costUsd: 0.01,
        turns: 1,
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
        modelUsage: {
          'fake-model': { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costUsd: 0.01 },
        },
      },
    ]);
  });

  it('resumes with the stored session id', async () => {
    const rec = await run('ok', { resumeSessionId: 'sess-42' });
    expect(rec.sessions).toEqual(['sess-42', 'sess-42']);
  });

  it('max turns: a result outcome that finishRun maps to limit_reached', async () => {
    const rec = await run('max-turns');
    expect(rec.exits[0]).toMatchObject({ type: 'result', subtype: 'error_max_turns', turns: 3 });
  });

  it('crash: failed outcome carries the redacted stderr tail and an error event', async () => {
    const rec = await run('crash');
    const outcome = rec.exits[0];
    expect(outcome).toMatchObject({ type: 'exit', code: 2 });
    const message = outcome?.type === 'exit' ? (outcome.message ?? '') : '';
    expect(message).toContain('fatal: something broke');
    expect(message).not.toContain('ghp_abcdefghijklmnop');
    expect(rec.events.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('creates an empty gh config directory for a worker run, none for a dispatcher (ADR-0022)', async () => {
    await run('ok', { runId: 'R-w', role: 'worker' });
    await run('ok', { runId: 'R-d', role: 'dispatcher' });
    expect(existsSync(join(home, 'runs', 'R-w', 'gh'))).toBe(true);
    expect(existsSync(join(home, 'runs', 'R-d', 'gh'))).toBe(false);
  });

  it('stop: SIGTERM ends a slow run with a stopped outcome', async () => {
    const rec = new Recorder();
    const handle = runnerFor('slow').start(specOf({ cwd: home }), rec);
    await rec.untilEvent('text', 'started');
    await handle.stop();
    expect(rec.exits).toEqual([{ type: 'stopped' }]);
  });

  it('stop right after start does not leave a process behind', async () => {
    const rec = new Recorder();
    const handle = runnerFor('slow').start(specOf({ cwd: home }), rec);
    await handle.stop();
    expect(rec.exits).toEqual([{ type: 'stopped' }]);
  });

  it('send(): an owner message reaches the live process', async () => {
    const rec = new Recorder();
    const handle = runnerFor('echo').start(specOf({ cwd: home, keepStdinOpen: true }), rec);
    await rec.untilEvent('text', 'ready');
    handle.send('please continue');
    await rec.exited();
    expect(rec.events).toContainEqual({ kind: 'text', payload: { text: 'echo: please continue' } });
    expect(rec.exits[0]).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it('jarvis_tool steps call the engine API with the run token', async () => {
    api = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', auth: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => api?.listen(0, '127.0.0.1', resolve));
    const port = (api.address() as AddressInfo).port;

    const rec = new Recorder();
    runnerFor('tool-call', { apiUrl: `http://127.0.0.1:${port}` }).start(
      specOf({ cwd: home, runToken: 'run-token-7' }),
      rec,
    );
    await rec.exited();

    expect(received).toEqual([
      {
        url: '/api/agent/tools/reply',
        auth: 'Bearer run-token-7',
        body: '{"text":"hello from fake"}',
      },
    ]);
    const names = rec.events.flatMap((e) => (e.kind === 'tool_use' ? [e.payload.name] : []));
    expect(names).toEqual(['mcp__jarvis__reply', 'Bash']);
    expect(rec.events).toContainEqual({
      kind: 'tool_result',
      payload: { toolUseId: 'toolu_fake_1', content: '{"ok":true}', isError: false },
    });
  });

  it('a missing binary ends the run as failed with a clear message', async () => {
    const rec = new Recorder();
    runnerFor('ok', { binary: join(home, 'no-such-claude') }).start(specOf({ cwd: home }), rec);
    await rec.exited();
    expect(rec.exits).toHaveLength(1);
    const outcome = rec.exits[0];
    expect(outcome).toMatchObject({ type: 'exit', code: null });
    expect(outcome?.type === 'exit' ? outcome.message : '').toContain('no-such-claude');
  });

  it('a throwing listener never breaks the stream', async () => {
    const calls: string[] = [];
    let finish: () => void = () => {};
    const exited = new Promise<void>((resolve) => (finish = resolve));
    const listener: RunListener = {
      async event() {
        calls.push('event');
        throw new Error('boom');
      },
      async session() {
        calls.push('session');
        throw new Error('boom');
      },
      async exit(outcome) {
        calls.push(`exit:${outcome.type}`);
        finish();
        throw new Error('boom');
      },
    };
    runnerFor('ok').start(specOf({ cwd: home }), listener);
    await exited;
    expect(calls).toEqual(['event', 'session', 'event', 'event', 'session', 'exit:result']);
  });
});
