import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentsMdRepoInfo } from './agents-md-repo-info.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'jarvis-repo-info-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('AgentsMdRepoInfo', () => {
  it('returns the commands and no warning when the file has check and dev commands', async () => {
    await writeFile(
      join(repo, 'AGENTS.md'),
      ['- Test: `pnpm test`', '- Lint: `pnpm lint`', '- Dev: `pnpm dev`'].join('\n'),
    );

    expect(await new AgentsMdRepoInfo().commands(repo)).toEqual({
      checkCommands: ['pnpm test', 'pnpm lint'],
      devCommand: 'pnpm dev',
      warning: null,
    });
  });

  it('warns about what the file lacks (CON-04)', async () => {
    await writeFile(join(repo, 'AGENTS.md'), '- Test: `pnpm test`\n');
    const onlyTests = await new AgentsMdRepoInfo().commands(repo);
    expect(onlyTests.warning).toBe(`${join(repo, 'AGENTS.md')} lists no dev command.`);

    await writeFile(join(repo, 'AGENTS.md'), '# Nothing useful\n');
    const nothing = await new AgentsMdRepoInfo().commands(repo);
    expect(nothing).toMatchObject({ checkCommands: [], devCommand: null });
    expect(nothing.warning).toBe(
      `${join(repo, 'AGENTS.md')} lists no test, lint or typecheck commands and no dev command.`,
    );
  });

  it('warns when AGENTS.md is missing or is not a file', async () => {
    const missing = await new AgentsMdRepoInfo().commands(repo);
    expect(missing).toMatchObject({ checkCommands: [], devCommand: null });
    expect(missing.warning).toContain('does not exist');

    await mkdir(join(repo, 'AGENTS.md'));
    expect((await new AgentsMdRepoInfo().commands(repo)).warning).toContain('cannot be read');
  });
});
