import { describe, expect, it } from 'vitest';
import { parseAgentsMd } from './parse-agents-md.js';

describe('parseAgentsMd', () => {
  it('reads a Commands table with a purpose column', () => {
    const markdown = [
      '## Commands',
      '',
      '| Purpose           | Command                                  |',
      '| ----------------- | ---------------------------------------- |',
      '| Test (unit + int) | `pnpm --filter @jarvis/engine test`      |',
      '| Typecheck         | `pnpm --filter @jarvis/engine typecheck` |',
      '| Dev server        | `pnpm dev`                               |',
      '| Install           | `pnpm install`                           |',
    ].join('\n');

    expect(parseAgentsMd(markdown)).toEqual({
      checkCommands: [
        'pnpm --filter @jarvis/engine test',
        'pnpm --filter @jarvis/engine typecheck',
      ],
      devCommand: 'pnpm dev',
    });
  });

  it('reads a module table whose columns are named after the command', () => {
    const markdown = [
      '| Module | Path      | Purpose | Test command                        | Typecheck command                        |',
      '| ------ | --------- | ------- | ----------------------------------- | ---------------------------------------- |',
      '| shared | `shared/` | Zod     | `pnpm --filter @jarvis/shared test` | `pnpm --filter @jarvis/shared typecheck` |',
      '| web    | `web/`    | React   | `pnpm --filter @jarvis/web test`    | `pnpm --filter @jarvis/web typecheck`    |',
    ].join('\n');

    expect(parseAgentsMd(markdown)).toEqual({
      checkCommands: [
        'pnpm --filter @jarvis/shared test',
        'pnpm --filter @jarvis/shared typecheck',
        'pnpm --filter @jarvis/web test',
        'pnpm --filter @jarvis/web typecheck',
      ],
      devCommand: null,
    });
  });

  it('reads list items and shell blocks, with comments as labels', () => {
    const markdown = [
      '# Repo',
      '- Run the linter: `npm run lint`',
      '- Start the app with `npm run dev`',
      '- Use `src/index.ts` as the entry point',
      '',
      '```bash',
      'pnpm install',
      '# unit tests',
      'pnpm vitest run',
      'make build   # compile everything',
      '```',
      '',
      '```',
      'docs/specs   what and why',
      '```',
    ].join('\n');

    expect(parseAgentsMd(markdown)).toEqual({
      checkCommands: ['npm run lint', 'pnpm vitest run', 'make build'],
      devCommand: 'npm run dev',
    });
  });

  it('ignores prose, file names and commands nobody labelled', () => {
    expect(
      parseAgentsMd(
        'Never run `pnpm install` blindly. The `README.md` explains `docker compose up`.',
      ),
    ).toEqual({ checkCommands: [], devCommand: null });
  });

  it('lists a command once', () => {
    const markdown = ['- Test: `pnpm test`', '', '```sh', 'pnpm test', '```'].join('\n');

    expect(parseAgentsMd(markdown).checkCommands).toEqual(['pnpm test']);
  });
});
