import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShellCheckRunner, tailOf } from './shell-check-runner.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-checks-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ENV = { PATH: process.env['PATH'], HOME: process.env['HOME'] };
const runner = (over: Partial<ConstructorParameters<typeof ShellCheckRunner>[0]> = {}) =>
  new ShellCheckRunner({ env: ENV, killGraceMs: 200, ...over });

const spec = (commands: string[], over: Record<string, unknown> = {}) => ({
  cwd: dir,
  commands,
  timeoutMs: 10_000,
  signal: new AbortController().signal,
  onProgress: () => undefined,
  logPath: join(dir, 'logs', 'checks', '1-abc1234.log'),
  ...over,
});

describe('ShellCheckRunner', () => {
  it('reports each exit code and runs every command even after a red one', async () => {
    const out = await runner().run(spec(['echo one', 'exit 3', 'echo three']));

    expect(out.unavailable).toBeNull();
    expect(out.results.map((r) => [r.command, r.exitCode, r.timedOut])).toEqual([
      ['echo one', 0, false],
      ['exit 3', 3, false],
      ['echo three', 0, false],
    ]);
    expect(out.results[0]?.tail).toBe('one');
  });

  it('runs in the given cwd with the allow-listed environment only', async () => {
    const out = await new ShellCheckRunner({
      env: { ...ENV, GITHUB_TOKEN: 'gho_secret' },
    }).run(spec(['pwd -P; echo "CI=$CI"; echo "token=[$GITHUB_TOKEN]"']));

    const tail = out.results[0]?.tail ?? '';
    expect(tail).toContain('CI=true');
    expect(tail).toContain('token=[]');
    expect(tail).not.toContain('gho_secret');
  });

  it('writes the whole output to the log, with a "$ command" line before each', async () => {
    const logPath = join(dir, 'a', 'b', 'log.log');
    await runner().run(spec(['echo hello', 'echo "oops" >&2; exit 1'], { logPath }));

    expect(await readFile(logPath, 'utf8')).toBe(
      '$ echo hello\nhello\n$ echo "oops" >&2; exit 1\noops\n',
    );
  });

  it('appends to a log that already exists', async () => {
    const logPath = join(dir, 'log.log');
    await runner().run(spec(['echo first'], { logPath }));
    await runner().run(spec(['echo second'], { logPath }));

    expect(await readFile(logPath, 'utf8')).toBe('$ echo first\nfirst\n$ echo second\nsecond\n');
  });

  it('keeps only the last 60 lines, at most 4 000 characters', async () => {
    const out = await runner().run(spec(['seq 1 500']));
    const lines = (out.results[0]?.tail ?? '').split('\n');
    expect(lines).toHaveLength(60);
    expect(lines.at(-1)).toBe('500');
    expect(lines[0]).toBe('441');

    const wide = await runner().run(spec(['head -c 20000 /dev/zero | tr "\\0" x']));
    expect(wide.results[0]?.tail).toHaveLength(4000);
  });

  it('tailOf trims trailing whitespace', () => {
    expect(tailOf('a\nb\n\n')).toBe('a\nb');
  });

  it('reports exit 127 as unavailable and stops the loop', async () => {
    const out = await runner().run(spec(['echo ok', 'no-such-command-xyz', 'echo never']));

    expect(out.results.map((r) => r.command)).toEqual(['echo ok', 'no-such-command-xyz']);
    expect(out.unavailable?.command).toBe('no-such-command-xyz');
    expect(out.unavailable?.detail).toMatch(/not found/);
  });

  it('reports a command that cannot be spawned (missing cwd) as unavailable', async () => {
    const out = await runner().run(spec(['echo hi'], { cwd: join(dir, 'does-not-exist') }));

    expect(out.unavailable?.command).toBe('echo hi');
    expect(out.results[0]?.exitCode).toBeNull();
  });

  it('kills a command that outlives its timeout and marks it timed out', async () => {
    const started = Date.now();
    const out = await runner().run(spec(['sleep 30', 'echo after'], { timeoutMs: 150 }));

    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.results[0]).toMatchObject({ command: 'sleep 30', timedOut: true });
    expect(out.results[0]?.exitCode).not.toBe(0);
    // Every command runs: a timeout is red, not a reason to stop.
    expect(out.results[1]).toMatchObject({ command: 'echo after', exitCode: 0 });
  });

  it('stops at once when the signal is aborted, and runs nothing after', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const out = await runner().run(spec(['sleep 30', 'echo never'], { signal: controller.signal }));

    expect(out.results.map((r) => r.command)).toEqual(['sleep 30']);
    expect(out.results[0]?.timedOut).toBe(false);
    expect(out.results[0]?.exitCode).not.toBe(0);
  });

  it('starts nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const out = await runner().run(spec(['echo hi'], { signal: controller.signal }));

    expect(out.results).toEqual([]);
  });

  it('reports progress about every progressMs while a command runs', async () => {
    const lines: string[] = [];
    await runner({ progressMs: 60 }).run(
      spec(['sleep 0.4'], { onProgress: (l: string) => lines.push(l) }),
    );

    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatch(/^checks running: sleep 0\.4 \(\d+s\)$/);
  });

  it('signals the process group (the negated pid), not just the shell', async () => {
    const signals: [number, string][] = [];
    await runner({
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid < 0) process.kill(pid, signal);
      },
    }).run(spec(['sleep 30'], { timeoutMs: 100 }));

    expect(signals.length).toBeGreaterThan(0);
    // The group first; a positive pid appears only as the fallback once the group is gone.
    expect(signals[0]?.[0]).toBeLessThan(0);
    expect(signals.filter(([pid]) => pid < 0).map(([, s]) => s)).toContain('SIGTERM');
  });
});
