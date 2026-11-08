import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { JarvisConfigSchema, type JarvisConfig } from '@jarvis/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessDevServer } from './process-dev-server.js';

const BASE_URL = 'http://127.0.0.1:5173';

function uiConfig(overrides: Partial<JarvisConfig['ui']> = {}): JarvisConfig['ui'] {
  const parsed = JarvisConfigSchema.parse({
    repo: { path: '/work/repo' },
    ui: { enabled: true, readyTimeoutSeconds: 1 },
  });
  return { ...parsed.ui, ...overrides };
}

/** A child process that never really runs: exits only when a test says so. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number | undefined) {
    super();
  }
  exit(code: number, output = ''): void {
    if (output !== '') this.stderr.emit('data', output);
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

interface Harness {
  readonly server: ProcessDevServer;
  readonly spawned: { command: string; cwd: string | undefined }[];
  readonly killed: { pid: number; signal: NodeJS.Signals }[];
  readonly children: FakeChild[];
  readonly stateFile: string;
  answers: boolean;
  logs: { level: string; message: string }[];
}

async function harness(
  options: {
    ui?: Partial<JarvisConfig['ui']>;
    pid?: number | undefined;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-dev-server-'));
  const stateFile = join(dir, 'dev-server.json');
  const spawned: Harness['spawned'] = [];
  const killed: Harness['killed'] = [];
  const children: FakeChild[] = [];
  const logs: Harness['logs'] = [];
  const h: Harness = {
    server: new ProcessDevServer({
      ui: () => uiConfig(options.ui),
      logger: {
        info: (message) => logs.push({ level: 'info', message }),
        warn: (message) => logs.push({ level: 'warn', message }),
        error: (message) => logs.push({ level: 'error', message }),
      },
      stateFile,
      pollMs: 1,
      killGraceMs: 10,
      spawn: ((command: string, opts: { cwd?: string }) => {
        spawned.push({ command, cwd: opts.cwd });
        const child = new FakeChild('pid' in options ? options.pid : 4242);
        children.push(child);
        return child as unknown as ChildProcess;
      }) as unknown as typeof nodeSpawn,
      killProcess: (pid, signal) => {
        killed.push({ pid, signal });
      },
      fetch: (async () => {
        if (!h.answers) throw new Error('ECONNREFUSED');
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch,
    }),
    spawned,
    killed,
    children,
    stateFile,
    answers: false,
    logs,
  };
  return h;
}

/** Starts the server, letting the readiness probe succeed once the process exists. */
async function startReady(h: Harness, taskId = 'T-1', cwd = '/work/worktree') {
  const pending = h.server.start(taskId, cwd);
  await vi.waitFor(() => expect(h.spawned.length).toBeGreaterThan(0));
  h.answers = true;
  return pending;
}

describe('ProcessDevServer', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('refuses when ui.enabled is false, and starts nothing', async () => {
    const h = await harness({ ui: { enabled: false } });

    const result = await h.server.start('T-1', '/work/worktree');

    expect(result).toMatchObject({ ok: false, reason: 'disabled' });
    expect(h.spawned).toHaveLength(0);
  });

  it('runs ui.devCommand in the task worktree and only answers once ready (AC-8)', async () => {
    const h = await harness();

    const result = await startReady(h, 'T-7', '/work/worktrees/T-7');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.lease).toMatchObject({ taskId: 'T-7', baseUrl: BASE_URL });
    expect(h.spawned).toEqual([{ command: 'pnpm dev', cwd: '/work/worktrees/T-7' }]);
  });

  it('records the pid so a later engine can clean up (AC-14)', async () => {
    const h = await harness();

    await startReady(h);

    const state = JSON.parse(await readFile(h.stateFile, 'utf8')) as Record<string, unknown>;
    expect(state).toEqual({ pid: 4242, taskId: 'T-1' });
  });

  it('refuses with not_ready and kills the process when the port never answers (AC-9)', async () => {
    const h = await harness();

    const result = await h.server.start('T-1', '/work/worktree');

    expect(result).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(h.killed.map((k) => k.signal)).toContain('SIGTERM');
    expect(h.server.current()).toBeNull();
  });

  it('refuses with exited and reports the output when the command dies early', async () => {
    const h = await harness();
    const pending = h.server.start('T-1', '/work/worktree');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]?.exit(1, 'ERR_PNPM_NO_SCRIPT  Missing script: dev');

    const result = await pending;

    expect(result).toMatchObject({ ok: false, reason: 'exited' });
    if (result.ok) throw new Error('expected refusal');
    expect(result.detail).toContain('Missing script: dev');
  });

  it('refuses a second task while a lease is live, and leaves it running (AC-10)', async () => {
    const h = await harness();
    await startReady(h, 'T-1');

    const result = await h.server.start('T-2', '/work/worktrees/T-2');

    expect(result).toMatchObject({ ok: false, reason: 'busy' });
    expect(h.spawned).toHaveLength(1);
    expect(h.killed).toHaveLength(0);
    expect(h.server.current()).toMatchObject({ taskId: 'T-1' });
  });

  it('renews instead of starting a second process for the same task (AC-11)', async () => {
    const h = await harness();
    const first = await startReady(h, 'T-1');
    if (!first.ok) throw new Error('expected success');

    const second = await h.server.start('T-1', '/work/worktree');

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected success');
    expect(second.lease.baseUrl).toBe(first.lease.baseUrl);
    expect(h.spawned).toHaveLength(1);
  });

  it('refuses with port_busy when something else already listens (AC-15)', async () => {
    const h = await harness();
    h.answers = true;

    const result = await h.server.start('T-1', '/work/worktree');

    expect(result).toMatchObject({ ok: false, reason: 'port_busy' });
    expect(h.spawned).toHaveLength(0);
  });

  it('stop kills the process group and clears the lease', async () => {
    const h = await harness();
    await startReady(h, 'T-1');

    await h.server.stop('T-1');

    expect(h.killed[0]).toEqual({ pid: -4242, signal: 'SIGTERM' });
    expect(h.server.current()).toBeNull();
  });

  it('stop by another task leaves the lease alone', async () => {
    const h = await harness();
    await startReady(h, 'T-1');

    await h.server.stop('T-2');

    expect(h.killed).toHaveLength(0);
    expect(h.server.current()).toMatchObject({ taskId: 'T-1' });
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const h = await harness();
    await startReady(h, 'T-1');

    await h.server.stop('T-1');

    expect(h.killed.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('kills the server by itself when the lease expires (AC-12)', async () => {
    const h = await harness({ ui: { leaseMinutes: 1 } });
    // The lease timer must exist on the fake clock, so it is installed before the server starts.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await startReady(h, 'T-1');
    expect(h.killed).toHaveLength(0);

    // The lease is the hard stop: nothing asks, the clock just runs out.
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(h.killed.length).toBeGreaterThan(0));

    expect(h.killed[0]).toEqual({ pid: -4242, signal: 'SIGTERM' });
    expect(h.server.current()).toBeNull();
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('lease expired'))).toBe(
      true,
    );
  });

  it('kills a server left over from a previous engine and forgets it (AC-14)', async () => {
    const h = await harness();
    await writeFile(h.stateFile, JSON.stringify({ pid: 777, taskId: 'T-9' }));

    await h.server.recover();

    expect(h.killed).toEqual([{ pid: -777, signal: 'SIGKILL' }]);
    await expect(readFile(h.stateFile, 'utf8')).rejects.toThrow();
  });

  it('recover is a no-op without a state file', async () => {
    const h = await harness();

    await h.server.recover();

    expect(h.killed).toHaveLength(0);
  });
});
