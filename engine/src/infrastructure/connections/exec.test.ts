import { describe, expect, it } from 'vitest';
import { execFileWith } from './exec.js';

const exec = execFileWith({ PATH: process.env['PATH'] ?? '' });

describe('execFileWith', () => {
  it('returns the output and exit code, a non-zero code included', async () => {
    expect(await exec(process.execPath, ['-e', 'console.log("hi")'], { timeoutMs: 5000 })).toEqual({
      stdout: 'hi\n',
      exitCode: 0,
    });
    expect(
      await exec(process.execPath, ['-e', 'console.log("no"); process.exit(3)'], {
        timeoutMs: 5000,
      }),
    ).toEqual({ stdout: 'no\n', exitCode: 3 });
  });

  it('rejects when the program does not exist or does not answer in time', async () => {
    await expect(exec('/no/such/binary', [], { timeoutMs: 5000 })).rejects.toThrow();
    await expect(
      exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 }),
    ).rejects.toThrow('did not answer within 100 ms');
  });

  it('passes only the given environment to the program', async () => {
    const result = await exec(
      process.execPath,
      ['-e', 'console.log(process.env.HOME ?? "unset")'],
      {
        timeoutMs: 5000,
      },
    );

    expect(result.stdout.trim()).toBe('unset');
  });
});
