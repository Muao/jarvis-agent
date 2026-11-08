import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisConfigSchema, type JarvisConfig } from '@jarvis/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessDevServer } from './process-dev-server.js';

/**
 * The real thing: a real child process group, the real readiness probe, real signals. The unit
 * tests fake the spawn; this one proves the adapter actually starts and stops a dev server.
 */

/** A free loopback port, found by binding and releasing one. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits for `predicate`, polling; returns false if it never holds. */
async function until(predicate: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

interface Fixture {
  readonly server: ProcessDevServer;
  readonly cwd: string;
  readonly port: number;
  /** The pid the child wrote once it was listening — its own, not the shell's. */
  pid(): Promise<number>;
}

const servers: ProcessDevServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stopAll()));
  servers.length = 0;
});

/**
 * A worktree holding a one-file "dev server": an http server that answers 200 and writes its own
 * pid to `pid.txt`, so the test can check the whole process group really died.
 */
async function fixture(
  options: { readonly ui?: Partial<JarvisConfig['ui']>; readonly ignoresSigterm?: boolean } = {},
): Promise<Fixture> {
  const overrides = options.ui ?? {};
  const cwd = await mkdtemp(join(tmpdir(), 'jarvis-dev-int-'));
  const port = await freePort();
  await writeFile(
    join(cwd, 'dev.mjs'),
    [
      "import { createServer } from 'node:http';",
      "import { writeFileSync } from 'node:fs';",
      "createServer((_, res) => res.end('ok')).listen(" + String(port) + ", '127.0.0.1', () => {",
      "  writeFileSync('pid.txt', String(process.pid));",
      '});',
      // Ignoring SIGTERM proves the adapter escalates to SIGKILL.
      ...(options.ignoresSigterm === true ? ["process.on('SIGTERM', () => {});"] : []),
    ].join('\n'),
  );

  const ui = {
    ...JarvisConfigSchema.parse({
      repo: { path: cwd },
      ui: {
        enabled: true,
        baseUrl: `http://127.0.0.1:${port}`,
        readyTimeoutSeconds: 15,
        ...overrides,
      },
    }).ui,
    devCommand: 'node dev.mjs',
  };

  const server = new ProcessDevServer({
    ui: () => ui,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    stateFile: join(cwd, 'dev-server.json'),
    env: { PATH: process.env['PATH'] },
    pollMs: 50,
    killGraceMs: 500,
  });
  servers.push(server);

  return {
    server,
    cwd,
    port,
    pid: async () => {
      const { readFile } = await import('node:fs/promises');
      return Number((await readFile(join(cwd, 'pid.txt'), 'utf8')).trim());
    },
  };
}

describe('ProcessDevServer against a real process', () => {
  it('starts the command, waits until it answers, and kills the whole group on stop', async () => {
    const f = await fixture();

    const started = await f.server.start('T-1', f.cwd);

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('expected success');
    expect(started.lease.baseUrl).toBe(`http://127.0.0.1:${f.port}`);
    await expect(fetch(`http://127.0.0.1:${f.port}/`).then((r) => r.status)).resolves.toBe(200);

    const pid = await f.pid();
    expect(alive(pid)).toBe(true);

    await f.server.stop('T-1');

    expect(await until(() => !alive(pid))).toBe(true);
    expect(f.server.current()).toBeNull();
    await expect(fetch(`http://127.0.0.1:${f.port}/`)).rejects.toThrow();
  }, 30_000);

  it('kills a server that ignores SIGTERM', async () => {
    const f = await fixture({ ignoresSigterm: true });

    await f.server.start('T-1', f.cwd);
    const pid = await f.pid();

    await f.server.stop('T-1');

    expect(await until(() => !alive(pid))).toBe(true);
  }, 30_000);

  it('stopAll kills the server nobody asked about, as the lease timer does (AC-12, AC-13)', async () => {
    const f = await fixture();
    await f.server.start('T-1', f.cwd);
    const pid = await f.pid();

    await f.server.stopAll();

    expect(await until(() => !alive(pid))).toBe(true);
  }, 30_000);

  it('refuses port_busy when the port is already taken by something else (AC-15)', async () => {
    const f = await fixture();
    const squatter = createServer((_, res) => res.end('mine'));
    await new Promise<void>((resolve) => squatter.listen(f.port, '127.0.0.1', resolve));

    try {
      expect(await f.server.start('T-1', f.cwd)).toMatchObject({ ok: false, reason: 'port_busy' });
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 30_000);

  it('refuses and cleans up when the command is not there (AC-9)', async () => {
    const f = await fixture();
    const broken = new ProcessDevServer({
      ui: () => ({
        ...JarvisConfigSchema.parse({
          repo: { path: f.cwd },
          ui: {
            enabled: true,
            baseUrl: `http://127.0.0.1:${f.port}`,
            readyTimeoutSeconds: 5,
            devCommand: 'node no-such-file.mjs',
          },
        }).ui,
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      stateFile: join(f.cwd, 'broken.json'),
      env: { PATH: process.env['PATH'] },
      pollMs: 50,
      killGraceMs: 500,
    });
    servers.push(broken);

    const result = await broken.start('T-1', f.cwd);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(['exited', 'not_ready']).toContain(result.reason);
    expect(broken.current()).toBeNull();
  }, 30_000);
});
