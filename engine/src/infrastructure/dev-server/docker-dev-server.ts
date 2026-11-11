import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePlanEnv,
  revealedPlanEnv,
  type EnvironmentPlan,
  type JarvisConfig,
} from '@jarvis/shared';
import type {
  DevServerLease,
  DevServerManager,
  DevServerRefusal,
  DevServerRefused,
  DevServerResult,
  Logger,
} from '../../application/index.js';

/** Every container and network of a check carries this label; cleanup finds them by it alone. */
export const CHECK_LABEL = 'jarvis.check';

const DEFAULT_POLL_MS = 500;
const OUTPUT_TAIL_CHARS = 3000;
const QUICK_MS = 15_000;
const SOURCE = '/src';
const WORKSPACE = '/workspace';

/** The only variables the `docker` CLI itself gets from the engine: where the daemon is, nothing else. */
const DOCKER_CLI_ENV = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'XDG_RUNTIME_DIR',
] as const;

export interface DockerResult {
  /** Null when the process was killed (timeout) or could not start. */
  readonly code: number | null;
  /** stdout and stderr together, in arrival order. */
  readonly output: string;
  readonly timedOut: boolean;
}

/** Runs `docker <args>` to completion. Injectable so unit tests never touch a daemon. */
export type DockerExec = (args: readonly string[], timeoutMs: number) => Promise<DockerResult>;

export interface DockerDevServerOptions {
  /** Read fresh on every call: the config is hot-reloaded (ADR-0005). */
  ui(): JarvisConfig['ui'];
  readonly logger: Logger;
  /** The engine's environment; only `DOCKER_CLI_ENV` of it reaches the `docker` CLI. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly docker?: DockerExec;
  readonly fetch?: typeof fetch;
  /** Whether nothing listens on this loopback port of the host. */
  readonly portFree?: (port: number) => Promise<boolean>;
  readonly pollMs?: number;
}

interface Running {
  readonly taskId: string;
  readonly plan: string;
  readonly baseUrl: string;
  readonly origins: readonly string[];
  revealed: Readonly<Record<string, string>>;
  expiresAtMs: number;
  timer: NodeJS.Timeout | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tail = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === '') return '(no output)';
  return trimmed.length <= OUTPUT_TAIL_CHARS ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}`;
};

const refuse = (
  reason: DevServerRefusal,
  detail: string,
  extra: { step?: string; exitCode?: number | null } = {},
): DevServerRefused => ({ ok: false, reason, detail, ...extra });

/** A refusal thrown from inside the start sequence; caught once, where the cleanup is. */
class Refusal extends Error {
  constructor(readonly refused: DevServerRefused) {
    super(refused.detail);
  }
}

const slug = (taskId: string): string => taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function defaultDocker(env: Readonly<Record<string, string | undefined>>): DockerExec {
  const cliEnv: Record<string, string> = {};
  for (const name of DOCKER_CLI_ENV) {
    const value = env[name];
    if (value !== undefined) cliEnv[name] = value;
  }
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      const child = spawn('docker', [...args], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      const collect = (chunk: unknown): void => {
        output = `${output}${String(chunk)}`.slice(-64 * 1024);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: null, output: error.message, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output, timedOut });
      });
    });
}

function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Succeeds when `$1:$2` accepts a TCP connection, with whatever the image has to try it. */
const TCP_PROBE = [
  'if command -v bash >/dev/null 2>&1; then bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null;',
  'elif command -v nc >/dev/null 2>&1; then nc -z "$1" "$2";',
  'elif command -v node >/dev/null 2>&1; then node -e',
  "\"const s=require('net').connect(+process.argv[2],process.argv[1]);",
  's.on(\'connect\',()=>process.exit(0));s.on(\'error\',()=>process.exit(1))" "$1" "$2";',
  'else exit 0; fi',
].join(' ');

/**
 * ADR-0026. Runs an environment plan the worker composed: the project's own commands in one
 * disposable container, each backing service with an image in its own, all on a network private to
 * the check. The plan chooses images, commands, ports and variables — never mounts, capabilities,
 * the user or the network; those are set here. The sources are mounted read-only and copied inside,
 * so nothing a check runs can write into the task's worktree. At most one lease engine-wide.
 */
export class DockerDevServer implements DevServerManager {
  private running: Running | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly docker: DockerExec;
  private readonly fetchImpl: typeof fetch;
  private readonly portFree: (port: number) => Promise<boolean>;

  constructor(private readonly options: DockerDevServerOptions) {
    this.docker = options.docker ?? defaultDocker(options.env ?? {});
    this.fetchImpl = options.fetch ?? fetch;
    this.portFree = options.portFree ?? defaultPortFree;
  }

  current(): DevServerLease | null {
    const running = this.running;
    if (running === null) return null;
    return {
      taskId: running.taskId,
      baseUrl: running.baseUrl,
      origins: running.origins,
      expiresAt: new Date(running.expiresAtMs).toISOString(),
    };
  }

  start(taskId: string, cwd: string, plan: EnvironmentPlan): Promise<DevServerResult> {
    return this.exclusive(() => this.startNow(taskId, cwd, plan));
  }

  async stop(taskId: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.running?.taskId === taskId) await this.teardown();
    });
  }

  stopAll(): Promise<void> {
    return this.exclusive(() => this.teardown());
  }

  /**
   * On engine start: removes whatever a previous engine left behind. Containers outlive the
   * process that started them, so the label is the record — there is no state file to trust.
   */
  async recover(): Promise<void> {
    const removed = await this.removeLabelled();
    if (removed > 0) {
      this.options.logger.warn('removed a check environment left over from a previous engine', {
        event: 'dev_server.recovered',
        containers: removed,
      });
    }
  }

  /** Calls never interleave: a stop waits for the start it would otherwise race. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async startNow(
    taskId: string,
    cwd: string,
    plan: EnvironmentPlan,
  ): Promise<DevServerResult> {
    const ui = this.options.ui();
    if (!ui.enabled) return refuse('disabled', 'ui.enabled is false in jarvis.config.json.');

    const planKey = JSON.stringify(plan);
    const live = this.running;
    if (live !== null) {
      if (live.taskId !== taskId) {
        return refuse('busy', `Task ${live.taskId} holds the UI check environment.`);
      }
      if (live.plan === planKey) {
        this.renew(live, ui.leaseMinutes);
        return this.started();
      }
      await this.teardown(); // the same task came back with a revised plan
    }

    const daemon = await this.docker(['version', '--format', '{{.Server.Version}}'], QUICK_MS);
    if (daemon.code !== 0) {
      return refuse(
        'docker_unavailable',
        `The Docker daemon does not answer, so no environment can run: ${tail(daemon.output)}`,
      );
    }

    const ports = [plan.app.port, ...plan.extraPorts];
    for (const port of ports) {
      if (!(await this.portFree(port))) {
        return refuse(
          'port_busy',
          `Port ${port} is already in use on this machine. Make the project listen on another port and put that port in the plan.`,
        );
      }
    }

    const origins = ports.map((port) => `http://127.0.0.1:${port}`);
    const running: Running = {
      taskId,
      plan: planKey,
      baseUrl: origins[0] as string,
      origins,
      revealed: {},
      expiresAtMs: 0,
      timer: undefined,
    };
    this.running = running;
    this.renew(running, ui.leaseMinutes);

    try {
      running.revealed = await this.bringUp(taskId, cwd, plan, ui);
    } catch (error) {
      await this.teardown();
      if (error instanceof Refusal) return error.refused;
      throw error;
    }
    // The lease expired while the environment was still coming up: it is already gone.
    if (this.running !== running) {
      return refuse('not_ready', 'The lease ran out before the environment was ready.');
    }
    this.options.logger.info('check environment ready', { event: 'dev_server.started', taskId });
    return this.started();
  }

  private async bringUp(
    taskId: string,
    cwd: string,
    plan: EnvironmentPlan,
    ui: JarvisConfig['ui'],
  ): Promise<Record<string, string>> {
    const name = `jarvis-check-${slug(taskId)}`;
    const app = `${name}-app`;
    const label = `${CHECK_LABEL}=${taskId}`;
    const stepMs = ui.prepareTimeoutSeconds * 1000;
    const appImage = plan.image ?? ui.defaultImage;

    for (const image of new Set([appImage, ...plan.services.flatMap((s) => s.image ?? [])])) {
      await this.step(`image ${image}`, ['pull', '--quiet', image], stepMs);
    }
    await this.step('network', ['network', 'create', '--label', label, name], QUICK_MS);

    // Secrets exist only in this file for the seconds the containers take to be created.
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-check-'));
    const envFile = join(dir, 'env');
    const env = resolvePlanEnv(plan, () => randomBytes(24).toString('hex'));
    await writeFile(
      envFile,
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
      { mode: 0o600 },
    );
    const common = [
      '--detach',
      '--label',
      label,
      '--network',
      name,
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '4096',
      '--env-file',
      envFile,
    ];

    try {
      await this.step(
        'app container',
        [
          'run',
          ...common,
          '--name',
          app,
          '--network-alias',
          'app',
          '--init',
          ...publishedPorts(plan).flatMap((port) => ['--publish', `127.0.0.1:${port}:${port}`]),
          '--volume',
          `${cwd}:${SOURCE}:ro`,
          '--workdir',
          WORKSPACE,
          '--entrypoint',
          'tail',
          appImage,
          '-f',
          '/dev/null',
        ],
        QUICK_MS * 2,
      );
      for (const service of plan.services) {
        if (service.image === undefined) continue;
        await this.step(
          `services.${service.name}`,
          [
            'run',
            ...common,
            '--name',
            `${name}-svc-${service.name}`,
            '--network-alias',
            service.name,
            service.image,
            ...(service.command === undefined ? [] : ['sh', '-c', service.command]),
          ],
          QUICK_MS * 2,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // A copy, not the mount: installs and builds must not touch the worktree (other architecture,
    // other Node), and a stranger's script must not be able to plant a file in it.
    await this.step(
      'copy sources',
      this.execIn(
        app,
        undefined,
        `tar -C ${SOURCE} --exclude=node_modules --exclude=.git -cf - . | tar -C ${WORKSPACE} -xf -`,
      ),
      stepMs,
    );

    for (const service of plan.services) {
      if (service.image === undefined || service.ready === undefined) continue;
      await this.waitForPort(
        app,
        `services.${service.name}`,
        service.name,
        service.ready.tcp,
        ui,
        () => this.containerDied(`${name}-svc-${service.name}`),
      );
    }

    for (const [index, command] of plan.prepare.entries()) {
      await this.step(`prepare[${index}]`, this.execIn(app, undefined, command), stepMs);
    }

    for (const service of plan.services) {
      if (service.image !== undefined || service.command === undefined) continue;
      const step = `services.${service.name}`;
      await this.background(app, step, service.name, service.cwd, service.command);
      if (service.ready !== undefined) {
        await this.waitForPort(app, step, '127.0.0.1', service.ready.tcp, ui, () =>
          this.backgroundDied(app, service.name),
        );
      }
    }

    await this.background(app, 'app', 'app', plan.app.cwd, plan.app.command);
    await this.waitForApp(app, plan, ui);
    return revealedPlanEnv(plan, env);
  }

  /** One `docker` call of the start sequence; anything but exit 0 ends the sequence. */
  private async step(step: string, args: readonly string[], timeoutMs: number): Promise<void> {
    const result = await this.docker(args, timeoutMs);
    if (result.code === 0) return;
    const how = result.timedOut
      ? `did not finish within ${Math.round(timeoutMs / 1000)}s`
      : `failed (exit code ${result.code ?? 'unknown'})`;
    throw new Refusal(
      refuse('step_failed', `${step} ${how}. Output: ${tail(result.output)}`, {
        step,
        exitCode: result.code,
      }),
    );
  }

  private execIn(container: string, cwd: string | undefined, command: string): string[] {
    const workdir = cwd === undefined ? WORKSPACE : `${WORKSPACE}/${cwd}`;
    return ['exec', '--workdir', workdir, container, 'sh', '-c', command];
  }

  /** Starts `command` in the app container and returns at once; its output and exit code go to files. */
  private async background(
    container: string,
    step: string,
    name: string,
    cwd: string | undefined,
    command: string,
  ): Promise<void> {
    const workdir = cwd === undefined ? WORKSPACE : `${WORKSPACE}/${cwd}`;
    const wrapper = `sh -c "$1" > /tmp/jarvis-${name}.log 2>&1; echo $? > /tmp/jarvis-${name}.exit`;
    await this.step(
      step,
      ['exec', '--detach', '--workdir', workdir, container, 'sh', '-c', wrapper, 'sh', command],
      QUICK_MS,
    );
  }

  /** `exit code + output tail` of a background command that has ended, or null while it runs. */
  private async backgroundDied(
    container: string,
    name: string,
  ): Promise<{ exitCode: number | null; output: string } | null> {
    const exit = await this.docker(
      ['exec', container, 'sh', '-c', `cat /tmp/jarvis-${name}.exit 2>/dev/null`],
      QUICK_MS,
    );
    const code = exit.output.trim();
    if (exit.code !== 0 || code === '') return null;
    return { exitCode: Number(code), output: await this.backgroundOutput(container, name) };
  }

  private async backgroundOutput(container: string, name: string): Promise<string> {
    const log = await this.docker(
      ['exec', container, 'sh', '-c', `tail -c ${OUTPUT_TAIL_CHARS} /tmp/jarvis-${name}.log`],
      QUICK_MS,
    );
    return log.output;
  }

  private async containerDied(
    container: string,
  ): Promise<{ exitCode: number | null; output: string } | null> {
    const state = await this.docker(
      ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', container],
      QUICK_MS,
    );
    const [isRunning, code] = state.output.trim().split(' ');
    if (state.code === 0 && isRunning === 'true') return null;
    const logs = await this.docker(['logs', '--tail', '40', container], QUICK_MS);
    return { exitCode: code === undefined ? null : Number(code), output: logs.output };
  }

  private async waitForPort(
    app: string,
    step: string,
    host: string,
    port: number,
    ui: JarvisConfig['ui'],
    died: () => Promise<{ exitCode: number | null; output: string } | null>,
  ): Promise<void> {
    const deadline = Date.now() + ui.readyTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const dead = await died();
      if (dead !== null) {
        throw new Refusal(
          refuse(
            'step_failed',
            `${step} exited before port ${port} opened. Output: ${tail(dead.output)}`,
            {
              step,
              exitCode: dead.exitCode,
            },
          ),
        );
      }
      const probe = await this.docker(
        ['exec', app, 'sh', '-c', TCP_PROBE, 'sh', host, String(port)],
        QUICK_MS,
      );
      if (probe.code === 0) return;
      await sleep(this.options.pollMs ?? DEFAULT_POLL_MS);
    }
    throw new Refusal(
      refuse(
        'not_ready',
        `${step}: ${host}:${port} did not accept a connection within ${ui.readyTimeoutSeconds}s.`,
        { step },
      ),
    );
  }

  private async waitForApp(
    app: string,
    plan: EnvironmentPlan,
    ui: JarvisConfig['ui'],
  ): Promise<void> {
    const url = new URL(plan.app.readyPath, `http://127.0.0.1:${plan.app.port}`);
    const deadline = Date.now() + ui.readyTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (await this.answers(url)) return;
      const dead = await this.backgroundDied(app, 'app');
      if (dead !== null) {
        throw new Refusal(
          refuse(
            'exited',
            `app.command exited (code ${dead.exitCode ?? 'unknown'}) before ${url.href} answered. Output: ${tail(dead.output)}`,
            { step: 'app', exitCode: dead.exitCode },
          ),
        );
      }
      await sleep(this.options.pollMs ?? DEFAULT_POLL_MS);
    }
    const output = await this.backgroundOutput(app, 'app');
    throw new Refusal(
      refuse(
        'not_ready',
        `${url.href} did not answer within ${ui.readyTimeoutSeconds}s. If the output below says the server is up, it listens on localhost only: make it listen on 0.0.0.0 (for example \`--host 0.0.0.0\`) and on port ${plan.app.port}. Output: ${tail(output)}`,
        { step: 'app' },
      ),
    );
  }

  private async answers(url: URL): Promise<boolean> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  /** The lease is live by construction here: only reached after `renew`. */
  private started(): DevServerResult {
    const lease = this.current();
    const revealed = this.running?.revealed ?? {};
    if (lease === null) throw new Error('the check environment lease vanished while starting');
    return Object.keys(revealed).length === 0 ? { ok: true, lease } : { ok: true, lease, revealed };
  }

  private renew(running: Running, leaseMinutes: number): void {
    if (running.timer !== undefined) clearTimeout(running.timer);
    running.expiresAtMs = Date.now() + leaseMinutes * 60_000;
    running.timer = setTimeout(() => {
      this.options.logger.warn('check environment lease expired, removing it', {
        event: 'dev_server.lease_expired',
        taskId: running.taskId,
      });
      // Not through the queue: a start that hangs must not keep its own expiry waiting.
      void this.teardown();
    }, leaseMinutes * 60_000);
    running.timer.unref?.();
  }

  private async teardown(): Promise<void> {
    const running = this.running;
    this.running = null;
    if (running?.timer !== undefined) clearTimeout(running.timer);
    const removed = await this.removeLabelled();
    if (running !== null) {
      this.options.logger.info('check environment removed', {
        event: 'dev_server.stopped',
        taskId: running.taskId,
        containers: removed,
      });
    }
  }

  /** Removes every labelled container, then every labelled network. Never throws. */
  private async removeLabelled(): Promise<number> {
    const filter = ['--filter', `label=${CHECK_LABEL}`];
    const containers = await this.docker(['ps', '--all', '--quiet', ...filter], QUICK_MS);
    const ids = containers.code === 0 ? containers.output.split(/\s+/).filter(Boolean) : [];
    if (ids.length > 0) {
      await this.docker(['rm', '--force', '--volumes', ...ids], QUICK_MS * 4);
    }
    const networks = await this.docker(['network', 'ls', '--quiet', ...filter], QUICK_MS);
    const nets = networks.code === 0 ? networks.output.split(/\s+/).filter(Boolean) : [];
    if (nets.length > 0) await this.docker(['network', 'rm', ...nets], QUICK_MS);
    return ids.length;
  }
}

const publishedPorts = (plan: EnvironmentPlan): number[] => [plan.app.port, ...plan.extraPorts];
