import {
  outsideLearned,
  parseMemory,
  renderEntry,
  selectForDispatcher,
  selectForWorker,
  type MemoryEntry,
} from '../../domain/index.js';

/** ADR-0021: what the engine puts into a run's first message out of `USER.md`. */

/** The owner's own sections — everything outside `## Learned` — or null when there is nothing. */
export function ownerSections(content: string | null): string | null {
  if (content === null) return null;
  const text = outsideLearned(content).trim();
  return text === '' ? null : text;
}

const PATH_LINE = /^([^\s:]+):\d+$/;

/** The files an agent entry cites by `path:line`; URLs and review comments have no file to check. */
function citedFiles(entry: MemoryEntry): string[] {
  return entry.citations.flatMap((citation) => {
    const match = PATH_LINE.exec(citation);
    return match === null || citation.startsWith('http') ? [] : [match[1] as string];
  });
}

export interface WorkerMemory {
  readonly entries: readonly MemoryEntry[];
  /** The soft cap left something out. */
  readonly cut: boolean;
}

/**
 * The `## Memory` block of a worker run: the unscoped entries and `repo`'s own, owner entries
 * first, ids visible. An agent entry citing a file the worktree no longer has is marked, and the
 * file on disk is not touched. Null when there is nothing to show.
 */
export async function workerMemoryBlock(input: {
  readonly content: string | null;
  /** `owner/name`; null when the repository is unknown, which leaves only unscoped entries. */
  readonly repo: string | null;
  readonly softCapChars: number;
  readonly fileExists: (relativePath: string) => Promise<boolean>;
}): Promise<string | null> {
  const document = parseMemory(input.content ?? '');
  const { entries, cut } = selectForWorker(document, input.repo ?? '', input.softCapChars);
  if (entries.length === 0 && !cut) return null;

  const lines: string[] = [];
  for (const entry of entries) {
    let line = renderEntry(entry);
    if (entry.origin === 'agent') {
      const present = await Promise.all(citedFiles(entry).map((file) => input.fileExists(file)));
      if (present.includes(false)) line += ' — citation missing';
    }
    lines.push(line);
  }
  if (cut) {
    lines.push(
      `- (The memory is over its ${input.softCapChars}-character cap: some entries are left out of this list. It is due for a review.)`,
    );
  }
  return ['## Memory', ...lines].join('\n');
}

/**
 * The `## Learned` block of a dispatcher run: owner entries of every scope, never an agent entry,
 * grouped under the repository they belong to. Null when there are none.
 */
export function dispatcherMemoryBlock(content: string | null): string | null {
  const owned = selectForDispatcher(parseMemory(content ?? ''));
  if (owned.length === 0) return null;
  const scopes = [...new Set(owned.map((entry) => entry.scope))];
  // Unscoped entries first, then each repository's subsection in file order.
  scopes.sort((a, b) => (a === null ? -1 : b === null ? 1 : 0));
  const lines = ['## Learned'];
  for (const scope of scopes) {
    if (scope !== null) lines.push('', `### ${scope}`);
    lines.push('', ...owned.filter((e) => e.scope === scope).map(renderEntry));
  }
  return lines.join('\n');
}
