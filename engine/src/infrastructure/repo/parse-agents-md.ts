export interface AgentsMdCommands {
  readonly checkCommands: readonly string[];
  readonly devCommand: string | null;
}

interface Candidate {
  /** Words that say what the command is for: a table header and row name, a list item, a comment. */
  readonly label: string;
  readonly command: string;
}

/** Only commands that start with a known tool count, so file names and prose in backticks do not. */
const RUNNER =
  /^(?:\$\s+)?(?:pnpm|npm|yarn|npx|bun|bunx|make|cargo|go|pytest|python3?|uv|poetry|node|tsx|vitest|jest|tsc|eslint|prettier|docker|turbo|nx|just|task|gradle|mvn|dotnet|bundle|rake|rspec|composer)\b/;

const DEV = /\bdev\b|\bserve\b|\bstart\b/i;
const CHECK = /\b(?:tests?|lint|typecheck|type-check|check|build|format|e2e)\b/i;

const FENCE = /^\s*```/;
const SEPARATOR_ROW = /^\|?[\s:|-]+\|?$/;
const BULLET = /^\s*(?:[-*+]|\d+\.)\s+/;
const SPAN = /`([^`]+)`/g;

const spansOf = (text: string): string[] =>
  [...text.matchAll(SPAN)].map((m) => (m[1] ?? '').trim()).filter((s) => RUNNER.test(s));

const plain = (text: string): string => text.replaceAll('`', '').replaceAll('*', '').trim();

function tableCandidates(row: string, header: readonly string[]): Candidate[] {
  const cells = row
    .split('|')
    .map((cell) => cell.trim())
    .filter((_, index, all) => index > 0 && index < all.length - 1);
  const name = plain(cells[0] ?? '');
  return cells.flatMap((cell, index) =>
    spansOf(cell).map((command) => ({
      label: `${plain(header[index] ?? '')} ${name}`,
      command,
    })),
  );
}

/** Splits `pnpm test   # run the unit tests` into its command and comment. */
function fenceCandidate(line: string, comment: string): Candidate | null {
  const [code = '', ...rest] = line.split(/\s+#\s+/);
  const command = code.trim();
  if (!RUNNER.test(command)) return null;
  return {
    label: `${rest.join(' ')} ${comment} ${command}`,
    command: command.replace(/^\$\s+/, ''),
  };
}

function candidatesOf(markdown: string): Candidate[] {
  const found: Candidate[] = [];
  let inFence = false;
  let comment = '';
  let header: string[] = [];
  let afterHeader = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      comment = '';
      continue;
    }
    if (inFence) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) comment = trimmed.replace(/^#+\s*/, '');
      else {
        const candidate = fenceCandidate(trimmed, comment);
        if (candidate !== null) found.push(candidate);
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) {
      if (SEPARATOR_ROW.test(trimmed)) {
        afterHeader = true;
        continue;
      }
      if (!afterHeader) {
        header = trimmed
          .split('|')
          .map((cell) => cell.trim())
          .filter((_, index, all) => index > 0 && index < all.length - 1);
        continue;
      }
      found.push(...tableCandidates(trimmed, header));
      continue;
    }
    header = [];
    afterHeader = false;
    if (BULLET.test(line)) {
      const label = plain(line.replace(BULLET, ''));
      found.push(...spansOf(line).map((command) => ({ label, command })));
    }
  }
  return found;
}

/**
 * Reads the test, lint, typecheck, build and dev commands a repository's `AGENTS.md` lists, in the
 * places such files put them: table rows (`| Test | \`pnpm test\` |`, or a "Test command" column),
 * list items (`- Lint: \`pnpm lint\``) and shell code blocks (`pnpm dev  # start the server`).
 * A command counts when it starts with a known tool and its label says what it is for.
 */
export function parseAgentsMd(markdown: string): AgentsMdCommands {
  const check: string[] = [];
  let dev: string | null = null;
  for (const { label, command } of candidatesOf(markdown)) {
    if (CHECK.test(label)) {
      if (!check.includes(command)) check.push(command);
    } else if (DEV.test(label)) {
      dev ??= command;
    }
  }
  return { checkCommands: check, devCommand: dev };
}
