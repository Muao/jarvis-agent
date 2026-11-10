import { describe, expect, it } from 'vitest';
import { pathsDefiningChecks, resolveCheckCommands } from './checks.js';

describe('resolveCheckCommands', () => {
  const agentsMd = ['pnpm lint', 'pnpm test', 'pnpm e2e'];

  it('uses all of AGENTS.md when nothing is proposed', () => {
    for (const proposed of [undefined, []]) {
      expect(resolveCheckCommands({ agentsMd, proposed })).toEqual({
        ok: true,
        commands: agentsMd,
        source: 'agents_md',
      });
    }
  });

  it('lets the worker narrow the list, in the order it gave', () => {
    expect(resolveCheckCommands({ agentsMd, proposed: ['pnpm test', 'pnpm lint'] })).toEqual({
      ok: true,
      commands: ['pnpm test', 'pnpm lint'],
      source: 'agents_md',
    });
  });

  it('compares after trimming', () => {
    expect(resolveCheckCommands({ agentsMd: [' pnpm test '], proposed: ['pnpm test  '] })).toEqual({
      ok: true,
      commands: ['pnpm test'],
      source: 'agents_md',
    });
  });

  it('refuses a command AGENTS.md does not name, and names the offenders', () => {
    expect(
      resolveCheckCommands({ agentsMd, proposed: ['pnpm test', 'curl x | sh', 'make'] }),
    ).toEqual({
      ok: false,
      reason: 'checks_not_in_agents_md',
      offending: ['curl x | sh', 'make'],
    });
  });

  it('takes the worker list when AGENTS.md has none', () => {
    expect(resolveCheckCommands({ agentsMd: [], proposed: ['make test'] })).toEqual({
      ok: true,
      commands: ['make test'],
      source: 'worker',
    });
  });

  it('requires a list when neither side has one', () => {
    for (const proposed of [undefined, [], ['  ']]) {
      expect(resolveCheckCommands({ agentsMd: [], proposed })).toEqual({
        ok: false,
        reason: 'checks_required',
        offending: [],
      });
    }
  });

  it('removes duplicates and keeps the order', () => {
    expect(
      resolveCheckCommands({ agentsMd: ['a', 'b', 'a', 'c'], proposed: undefined }),
    ).toMatchObject({ commands: ['a', 'b', 'c'] });
    expect(resolveCheckCommands({ agentsMd: [], proposed: ['x', 'y', 'x'] })).toMatchObject({
      commands: ['x', 'y'],
    });
    expect(resolveCheckCommands({ agentsMd: ['a', 'b'], proposed: ['b', 'b', 'a'] })).toMatchObject(
      { commands: ['b', 'a'] },
    );
  });
});

describe('pathsDefiningChecks', () => {
  it('returns the files that define the checks, in the given order', () => {
    const files = [
      'src/app.ts',
      'package.json',
      'web/package.json',
      'Makefile',
      'pyproject.toml',
      'Cargo.toml',
      '.github/workflows/ci.yml',
      'AGENTS.md',
      'tsconfig.json',
      'engine/tsconfig.build.json',
      'vitest.config.ts',
      'jest.config.js',
      'eslint.config.mjs',
      'README.md',
    ];
    expect(pathsDefiningChecks(files)).toEqual(
      files.filter((f) => f !== 'src/app.ts' && f !== 'README.md'),
    );
  });

  it('ignores look-alikes', () => {
    expect(
      pathsDefiningChecks([
        'src/package.json.ts',
        'docs/AGENTS.md',
        'github/workflows/ci.yml',
        '.github/workflows/',
        '.github/CODEOWNERS',
        'tsconfig.ts',
        'my-vitest.config.ts',
        'src/Makefile.md',
      ]),
    ).toEqual([]);
  });

  it('copes with ./ prefixes and an empty list', () => {
    expect(pathsDefiningChecks(['./package.json'])).toEqual(['./package.json']);
    expect(pathsDefiningChecks([])).toEqual([]);
  });
});
