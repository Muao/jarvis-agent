import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { JarvisConfig } from '@jarvis/shared';
import type {
  DevServerLease,
  DevServerManager,
  DevServerRefusal,
  DevServerRefused,
  DevServerResult,
  DevServerStarted,
  Logger,
} from '../../application/index.js';

const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_POLL_MS = 500;
const OUTPUT_TAIL_BYTES = 2048;

type Spawn = typeof nodeSpawn;

export interface ProcessDevServerOptions {
  /** Read fresh on every call: the config is hot-reloaded (ADR-0005). */
  ui(): JarvisConfig['ui'];
  readonly logger: Logger;
  /** `~/.jarvis/dev-server.json`: the pid of a server that outlived the engine (AC-14). */
  readonly stateFile: string;
  /** Environment the dev command inherits. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: Spawn;
  /** Injectable so tests never signal a real process group. */
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly fetch?: typeof fetch;
  readonly killGraceMs?: number;
  readonly pollMs?: number;
}

interface Running {
  readonly taskId: string;
  readonly child: ChildProcess;
  /** The negated pid used to signal the whole group, or the pid when detaching failed. */
  readonly pid: number;
  expiresAtMs: number;
  timer: NodeJS.Timeout | undefined;
  output: string;
  exited: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const refuse = (reason: DevServerRefusal, detail: string): DevServerRefused => ({
  ok: false,
  reason,
  detail,
});

/**
 * ADR-0014. Runs `ui.devCommand` as a detached process group so the engine can kill the server
 * and everything it spawned (a dev server is usually a shell that forks a bundler). Holds at most
 * one lease engine-wide; the lease is the hard stop that makes a runaway UI check finite.
 */
/**
 * `baseUrl` plus the same port on the other loopback family, so IPv4/IPv6 never decides whether a
 * running dev server is seen. A non-loopback host (which the config refuses anyway) is left alone.
 */
export function loopbackVariants(baseUrl: string): string[] {
  const url = new URL(baseUrl);
  const other = { '127.0.0.1': '[::1]', localhost: '[::1]', '[::1]': '127.0.0.1' }[url.hostname];
  if (other === undefined) return [baseUrl];
  const twin = new URL(baseUrl);
  twin.hostname = other;
  return [baseUrl, twin.toString()];
}

export class ProcessDevServer implements DevServerManager {
  private running: Running | null = null;
  private readonly spawn: Spawn;
  private readonly fetchImpl: typeof fetch;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;

  constructor(private readonly options: ProcessDevServerOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.fetchImpl = options.fetch ?? fetch;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  }

  current(): DevServerLease | null {
    const running = this.running;
    if (running === null) return null;
    return {
      taskId: running.taskId,
      baseUrl: this.options.ui().baseUrl,
      expiresAt: new Date(running.expiresAtMs).toISOString(),
    };
  }

  async start(taskId: string, cwd: string): Promise<DevServerResult> {
    const ui = this.options.ui();
    if (!ui.enabled) {
      return refuse('disabled', 'ui.enabled is false in jarvis.config.json.');
    }

    const live = this.running;
    if (live !== null && !live.exited) {
      if (live.taskId !== taskId) {
        return refuse('busy', `Task ${live.taskId} holds the dev server lease.`);
      }
      this.renew(live, ui.leaseMinutes);
      return this.started();
    }

    if (await this.answers(ui)) {
      return refuse(
        'port_busy',
        `${ui.baseUrl} already answers, and it is not a server this engine started. Stop it first.`,
      );
    }

    return this.launch(taskId, cwd, ui);
  }

  async stop(taskId: string): Promise<void> {
    if (this.running?.taskId !== taskId) return;
    await this.stopAll();
  }

  async stopAll(): Promise<void> {
    const running = this.running;
    this.running = null;
    if (running === null) return;
    if (running.timer !== undefined) clearTimeout(running.timer);
    await this.kill(running.pid, running.child);
    await rm(this.options.stateFile, { force: true });
    this.options.logger.info('dev server stopped', {
      event: 'dev_server.stopped',
      taskId: running.taskId,
    });
  }

  /**
   * On engine start: kills a dev server left behind by a previous process and drops the record.
   * Called before any task may take the lease (AC-14).
   */
  async recover(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.options.stateFile, 'utf8');
    } catch {
      return;
    }
    await rm(this.options.stateFile, { force: true });
    const pid = Number((JSON.parse(raw) as { pid?: unknown }).pid);
    if (!Number.isInteger(pid) || pid <= 1) return;
    const killed = this.signal(pid, 'SIGKILL');
    this.options.logger.warn('killed a dev server left over from a previous engine', {
      event: 'dev_server.recovered',
      pid,
      killed,
    });
  }

  private async launch(
    taskId: string,
    cwd: string,
    ui: JarvisConfig['ui'],
  ): Promise<DevServerResult> {
    const child = this.spawn(ui.devCommand, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...this.options.env } as NodeJS.ProcessEnv,
    });
    if (child.pid === undefined) {
      return refuse('exited', `Could not start \`${ui.devCommand}\`.`);
    }

    const running: Running = {
      taskId,
      child,
      pid: child.pid,
      expiresAtMs: 0,
      timer: undefined,
      output: '',
      exited: false,
    };
    const collect = (chunk: unknown): void => {
      running.output = `${running.output}${String(chunk)}`.slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      running.exited = true;
      collect(error.message);
    });
    child.on('exit', () => {
      running.exited = true;
    });

    this.running = running;
    this.renew(running, ui.leaseMinutes);
    await writeFile(this.options.stateFile, `${JSON.stringify({ pid: child.pid, taskId })}\n`, {
      mode: 0o600,
    });

    const refusal = await this.waitForReady(running, ui);
    if (refusal !== null) {
      await this.stopAll();
      return refusal;
    }
    this.options.logger.info('dev server ready', {
      event: 'dev_server.started',
      taskId,
      pid: child.pid,
    });
    return this.started();
  }

  /** The lease is live by construction here: `start` only reaches this after `renew`. */
  private started(): DevServerStarted {
    const lease = this.current();
    if (lease === null) throw new Error('dev server lease vanished while starting');
    return { ok: true, lease };
  }

  /** Null once the server answers; a refusal when it exits or never answers. */
  private async waitForReady(
    running: Running,
    ui: JarvisConfig['ui'],
  ): Promise<DevServerRefused | null> {
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    const deadline = Date.now() + ui.readyTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (running.exited) {
        return refuse(
          'exited',
          `\`${ui.devCommand}\` exited before ${ui.baseUrl} answered. Output: ${running.output.trim() || '(none)'}`,
        );
      }
      if (await this.answers(ui)) return null;
      await sleep(pollMs);
    }
    return refuse(
      'not_ready',
      `${ui.baseUrl}${ui.readyPath} did not answer within ${ui.readyTimeoutSeconds}s. Output: ${running.output.trim() || '(none)'}`,
    );
  }

  /**
   * The configured URL first, then the other loopback family. A dev server told to listen on
   * `localhost` (Vite's default) binds whichever family its runtime resolves first, and inside the
   * container that is `::1` — so a probe of `127.0.0.1` never sees a server that is up and running.
   * Observed on 2026-11-08: Vite reported ready in 272 ms and the check still timed out after 90 s.
   */
  private async answers(ui: JarvisConfig['ui']): Promise<boolean> {
    for (const base of loopbackVariants(ui.baseUrl)) {
      if (await this.answersAt(new URL(ui.readyPath, base))) return true;
    }
    return false;
  }

  private async answersAt(url: URL): Promise<boolean> {
    try {
      const response = await this.fetchImpl(url, { method: 'GET', redirect: 'manual' });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  private renew(running: Running, leaseMinutes: number): void {
    if (running.timer !== undefined) clearTimeout(running.timer);
    running.expiresAtMs = Date.now() + leaseMinutes * 60_000;
    running.timer = setTimeout(() => {
      this.options.logger.warn('dev server lease expired, killing it', {
        event: 'dev_server.lease_expired',
        taskId: running.taskId,
      });
      void this.stopAll();
    }, leaseMinutes * 60_000);
    running.timer.unref?.();
  }

  private async kill(pid: number, child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.signal(pid, 'SIGTERM');
    const grace = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const deadline = Date.now() + grace;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await sleep(Math.min(100, grace));
    }
    this.signal(pid, 'SIGKILL');
  }

  /** Signals the whole process group; falls back to the single pid when there is no group. */
  private signal(pid: number, signal: NodeJS.Signals): boolean {
    try {
      this.killProcess(-pid, signal);
      return true;
    } catch {
      try {
        this.killProcess(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  }
}
