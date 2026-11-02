import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoCommands, RepoInfo } from '../../application/ports/repo-info.js';
import { parseAgentsMd } from './parse-agents-md.js';

/** Reads `<repo>/AGENTS.md` fresh on every call, so an edit shows up on the next look (CON-04). */
export class AgentsMdRepoInfo implements RepoInfo {
  async commands(repoPath: string): Promise<RepoCommands> {
    const file = join(repoPath, 'AGENTS.md');
    let markdown: string;
    try {
      markdown = await readFile(file, 'utf8');
    } catch (error) {
      const reason =
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'does not exist' : 'cannot be read';
      return {
        checkCommands: [],
        devCommand: null,
        warning: `${file} ${reason}, so Jarvis cannot tell the worker which checks to run.`,
      };
    }
    const { checkCommands, devCommand } = parseAgentsMd(markdown);
    const missing = [
      ...(checkCommands.length === 0 ? ['test, lint or typecheck commands'] : []),
      ...(devCommand === null ? ['dev command'] : []),
    ];
    return {
      checkCommands,
      devCommand,
      warning: missing.length === 0 ? null : `${file} lists no ${missing.join(' and no ')}.`,
    };
  }
}
