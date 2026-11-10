/**
 * ADR-0022: pure rules for the check commands the engine runs before it opens a pull request.
 * No process, no file access: the commands come in as strings and go out as strings.
 */

export type CheckCommandSource = 'agents_md' | 'worker';

export type CheckCommandRefusal = 'checks_required' | 'checks_not_in_agents_md';

export type ResolvedCheckCommands =
  | { readonly ok: true; readonly commands: readonly string[]; readonly source: CheckCommandSource }
  | {
      readonly ok: false;
      readonly reason: CheckCommandRefusal;
      /** The `proposed` entries that are not in `AGENTS.md`'s list (`checks_not_in_agents_md`). */
      readonly offending: readonly string[];
    };

/** Trims, drops empty entries and duplicates; keeps the order of the first occurrence. */
function normalise(commands: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of commands ?? []) {
    const command = raw.trim();
    if (command === '' || seen.has(command)) continue;
    seen.add(command);
    result.push(command);
  }
  return result;
}

/**
 * Decides the list that spec approval will freeze. `AGENTS.md`'s commands win: the worker may only
 * narrow them. Without any, the worker's own list is accepted; without that, there is no list.
 */
export function resolveCheckCommands(input: {
  readonly agentsMd: readonly string[];
  readonly proposed: readonly string[] | undefined;
}): ResolvedCheckCommands {
  const agentsMd = normalise(input.agentsMd);
  const proposed = normalise(input.proposed);

  if (agentsMd.length > 0) {
    if (proposed.length === 0) return { ok: true, commands: agentsMd, source: 'agents_md' };
    const known = new Set(agentsMd);
    const offending = proposed.filter((command) => !known.has(command));
    if (offending.length > 0) return { ok: false, reason: 'checks_not_in_agents_md', offending };
    return { ok: true, commands: proposed, source: 'agents_md' };
  }

  if (proposed.length > 0) return { ok: true, commands: proposed, source: 'worker' };
  return { ok: false, reason: 'checks_required', offending: [] };
}

/** File names (any directory) whose content changes what "the checks" mean. */
const CHECK_FILE_NAMES: ReadonlySet<string> = new Set([
  'package.json',
  'Makefile',
  'pyproject.toml',
  'Cargo.toml',
]);

const CHECK_FILE_PATTERNS: readonly RegExp[] = [
  /^tsconfig.*\.json$/,
  /^vitest\.config\..+$/,
  /^jest\.config\..+$/,
  /^eslint\.config\..+$/,
];

/**
 * The subset of `files` (repository-relative paths) that define how the checks behave, so the PR
 * can name them: a task may edit them after the command list was frozen. A fixed list, no globbing.
 * `AGENTS.md` and `.github/workflows/` count at the repository root only; the rest in any directory.
 */
export function pathsDefiningChecks(files: readonly string[]): string[] {
  return files.filter((file) => {
    const path = file.replace(/\\/g, '/').replace(/^\.\//, '');
    if (path === 'AGENTS.md') return true;
    if (path.startsWith('.github/workflows/') && path.length > '.github/workflows/'.length) {
      return true;
    }
    const name = path.slice(path.lastIndexOf('/') + 1);
    return CHECK_FILE_NAMES.has(name) || CHECK_FILE_PATTERNS.some((re) => re.test(name));
  });
}
