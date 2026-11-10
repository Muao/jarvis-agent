import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShellCheckRunner } from './shell-check-runner.js';

/**
 * The real thing: a command that forks a grandchild, a real timeout and a real abort. A grandchild
 * is what `child.kill()` leaves behind; the whole group must go (ADR-0022).
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-checks-int-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(predicate: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** `sh` starts a grandchild `sleep`, writes its pid, and waits. SIGTERM-proof on purpose. */
const SPAWNS_GRANDCHILD = 'trap "" TERM; sleep 120 & echo $! > grandchild.pid; wait';

async function grandchildPid(): Promise<number> {
  expect(
    await until(() => {
      try {
        return Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8')) > 0;
      } catch {
        return false;
      }
    }),
  ).toBe(true);
  return Number((await readFile(join(dir, 'grandchild.pid'), 'utf8')).trim());
}

const make = () => new ShellCheckRunner({ env: { PATH: process.env['PATH'] }, killGraceMs: 300 });
const base = () => ({
  cwd: dir,
  onProgress: () => undefined,
  logPath: join(dir, 'log.log'),
});

describe('ShellCheckRunner (real processes)', () => {
  it('leaves no grandchild after a timeout', async () => {
    const run = make().run({
      ...base(),
      commands: [SPAWNS_GRANDCHILD],
      timeoutMs: 700,
      signal: new AbortController().signal,
    });
    const pid = await grandchildPid();
    expect(alive(pid)).toBe(true);

    const out = await run;

    expect(out.results[0]?.timedOut).toBe(true);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('leaves no grandchild after an abort', async () => {
    const controller = new AbortController();
    const run = make().run({
      ...base(),
      commands: [SPAWNS_GRANDCHILD],
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const pid = await grandchildPid();
    expect(alive(pid)).toBe(true);

    controller.abort();
    const out = await run;

    expect(out.results[0]?.timedOut).toBe(false);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('cleans up a background process a finished command left behind', async () => {
    const out = await make().run({
      ...base(),
      commands: ['sleep 120 & echo $! > grandchild.pid'],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(out.results[0]?.exitCode).toBe(0);
    const pid = Number((await readFile(join(dir, 'grandchild.pid'), 'utf8')).trim());
    expect(await until(() => !alive(pid))).toBe(true);
  });
});
