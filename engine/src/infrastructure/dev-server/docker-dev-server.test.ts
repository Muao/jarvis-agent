import {
  EnvironmentPlanSchema,
  JarvisConfigSchema,
  type EnvironmentPlanInput,
} from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../application/index.js';
import { DockerDevServer, type DockerResult } from './docker-dev-server.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const OK: DockerResult = { code: 0, output: '', timedOut: false };

const plan = (input: Partial<EnvironmentPlanInput> = {}) =>
  EnvironmentPlanSchema.parse({
    prepare: ['npm ci'],
    services: [
      { name: 'db', image: 'mongo:7', ready: { tcp: 27017 } },
      { name: 'api', command: 'node server.js', cwd: 'server', ready: { tcp: 5001 } },
    ],
    app: { command: 'npm run dev', cwd: 'client', port: 5173 },
    extraPorts: [5001],
    env: { JWT_SECRET: { generate: true }, ADMIN_PASSWORD: { generate: true, reveal: true } },
    ...input,
  });

interface Setup {
  ui?: Record<string, unknown>;
  /** Answers for calls whose joined arguments contain the key; the default is success. */
  answers?: Record<string, DockerResult>;
  portFree?: (port: number) => Promise<boolean>;
  appAnswers?: boolean;
}

function setup(options: Setup = {}) {
  const calls: string[][] = [];
  const ui = JarvisConfigSchema.parse({
    repo: { path: '/repo' },
    ui: { enabled: true, readyTimeoutSeconds: 1, ...options.ui },
  }).ui;
  const answers: Record<string, DockerResult> = {
    // A background command that is still running has written no exit file.
    '.exit 2>/dev/null': { code: 1, output: '', timedOut: false },
    'inspect --format': { code: 0, output: 'true 0', timedOut: false },
    ...options.answers,
  };
  const server = new DockerDevServer({
    ui: () => ui,
    logger,
    pollMs: 1,
    portFree: options.portFree ?? (async () => true),
    fetch: (async () => {
      if (options.appAnswers === false) throw new Error('refused');
      return new Response('ok');
    }) as typeof fetch,
    docker: async (args) => {
      calls.push([...args]);
      const line = args.join(' ');
      for (const [key, answer] of Object.entries(answers)) if (line.includes(key)) return answer;
      return OK;
    },
  });
  const lines = (): string[] => calls.map((c) => c.join(' '));
  return { server, calls, lines };
}

describe('DockerDevServer (ADR-0026)', () => {
  it('brings a plan up in order: images, network, containers, copy, prepare, services, app', async () => {
    const { server, lines } = setup();

    const result = await server.start('T-1', '/worktrees/T-1', plan());

    expect(result).toMatchObject({
      ok: true,
      lease: {
        taskId: 'T-1',
        baseUrl: 'http://127.0.0.1:5173',
        origins: ['http://127.0.0.1:5173', 'http://127.0.0.1:5001'],
      },
    });
    const order = [
      'version',
      'pull --quiet node:22-bookworm',
      'pull --quiet mongo:7',
      'network create --label jarvis.check=T-1 jarvis-check-t-1',
      '--name jarvis-check-t-1-app',
      '--name jarvis-check-t-1-svc-db',
      'tar -C /src',
      'sh -c npm ci',
      'sh node server.js',
      'sh npm run dev',
    ];
    let at = -1;
    for (const step of order) {
      const next = lines().findIndex((line, index) => index > at && line.includes(step));
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
  });

  it('sets the boundary itself: read-only sources, loopback ports, no engine files', async () => {
    const { server, lines } = setup();
    await server.start('T-1', '/worktrees/T-1', plan());

    const app = lines().find((line) => line.includes('--name jarvis-check-t-1-app')) ?? '';
    expect(app).toContain('--volume /worktrees/T-1:/src:ro');
    expect(app).toContain('--publish 127.0.0.1:5173:5173');
    expect(app).toContain('--publish 127.0.0.1:5001:5001');
    expect(app).toContain('--security-opt no-new-privileges');
    expect(app).toContain('--network jarvis-check-t-1');
    expect(app).not.toContain('--privileged');
    expect(lines().filter((line) => line.includes('--volume'))).toHaveLength(1);
  });

  it('keeps generated values out of every docker argument and returns only the revealed ones', async () => {
    const { server, lines } = setup();

    const result = await server.start('T-1', '/worktrees/T-1', plan());

    if (!result.ok) throw new Error('expected success');
    expect(Object.keys(result.revealed ?? {})).toEqual(['ADMIN_PASSWORD']);
    const secret = result.revealed?.['ADMIN_PASSWORD'] ?? '';
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect(lines().join('\n')).not.toContain(secret);
  });

  it('reports the failing step with its exit code and output, and removes what it started', async () => {
    const { server, lines } = setup({
      answers: {
        'sh -c npm ci': { code: 1, output: 'npm ERR! missing lockfile', timedOut: false },
      },
    });

    const result = await server.start('T-1', '/worktrees/T-1', plan());

    expect(result).toMatchObject({
      ok: false,
      reason: 'step_failed',
      step: 'prepare[0]',
      exitCode: 1,
    });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.detail).toContain('npm ERR! missing lockfile');
    expect(
      lines().some((line) => line.startsWith('ps --all --quiet --filter label=jarvis.check')),
    ).toBe(true);
    expect(server.current()).toBeNull();
  });

  it('says so when the app exits before its page answers', async () => {
    const { server } = setup({
      appAnswers: false,
      answers: {
        '.exit 2>/dev/null': { code: 0, output: '1\n', timedOut: false },
        'tail -c 3000 /tmp/jarvis-app.log': { code: 0, output: 'Error: no DB', timedOut: false },
      },
    });

    const result = await server.start('T-1', '/w', plan({ services: [] }));

    expect(result).toMatchObject({ ok: false, reason: 'exited', step: 'app', exitCode: 1 });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.detail).toContain('Error: no DB');
  });

  it('times out as not_ready and hints at 0.0.0.0', async () => {
    const { server } = setup({ appAnswers: false });

    const result = await server.start('T-1', '/w', plan({ services: [] }));

    expect(result).toMatchObject({ ok: false, reason: 'not_ready', step: 'app' });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.detail).toContain('0.0.0.0');
  });

  it('refuses without starting anything: disabled, no daemon, a taken port', async () => {
    const disabled = setup({ ui: { enabled: false } });
    expect(await disabled.server.start('T-1', '/w', plan())).toMatchObject({ reason: 'disabled' });
    expect(disabled.calls).toHaveLength(0);

    const noDaemon = setup({
      answers: {
        version: { code: 1, output: 'Cannot connect to the Docker daemon', timedOut: false },
      },
    });
    expect(await noDaemon.server.start('T-1', '/w', plan())).toMatchObject({
      reason: 'docker_unavailable',
    });
    expect(noDaemon.calls).toHaveLength(1);

    const taken = setup({ portFree: async (port) => port !== 5001 });
    const result = await taken.server.start('T-1', '/w', plan());
    expect(result).toMatchObject({ ok: false, reason: 'port_busy' });
    expect(taken.lines().some((line) => line.startsWith('run'))).toBe(false);
  });

  it('holds one lease: another task is busy, the same plan renews, a new plan replaces', async () => {
    const { server, lines } = setup();
    await server.start('T-1', '/w', plan());
    const runs = (): number =>
      lines()
        .filter((line) => line.includes('-app'))
        .filter((l) => l.startsWith('run')).length;

    expect(await server.start('T-2', '/w2', plan())).toMatchObject({ ok: false, reason: 'busy' });
    expect(await server.start('T-1', '/w', plan())).toMatchObject({ ok: true });
    expect(runs()).toBe(1);

    expect(await server.start('T-1', '/w', plan({ prepare: ['pnpm i'] }))).toMatchObject({
      ok: true,
    });
    expect(runs()).toBe(2);
  });

  it('stops by label: every container and network of a check goes, whoever started it', async () => {
    const { server, lines } = setup({
      answers: {
        'ps --all': { code: 0, output: 'c1\nc2\n', timedOut: false },
        'network ls': { code: 0, output: 'n1\n', timedOut: false },
      },
    });

    await server.recover();

    expect(lines()).toContain('rm --force --volumes c1 c2');
    expect(lines()).toContain('network rm n1');
  });
});
