import { readFile, writeFile } from 'node:fs/promises';

/** Structural match for the application's ProfileStore port. */
export interface UserPreferencesSource {
  userPreferences(): Promise<string | null>;
  appendLearned(fact: string): Promise<void>;
}

/**
 * Inserts `fact` as a new bullet under a `## Learned` heading in `content`, touching no other
 * byte (ADR-0020). Creates the heading at end-of-file when it is missing; an empty `content`
 * produces a minimal file with just the heading and the fact.
 */
export function insertLearnedBullet(content: string, fact: string): string {
  const bullet = `- ${fact}`;
  const headingMatch = /^## Learned[ \t]*$/m.exec(content);

  if (headingMatch === null) {
    const base = content.length === 0 ? '' : content.endsWith('\n') ? content : `${content}\n`;
    const separator = base.length === 0 ? '' : '\n';
    return `${base}${separator}## Learned\n\n${bullet}\n`;
  }

  const headingEnd = headingMatch.index + headingMatch[0].length;
  const rest = content.slice(headingEnd);
  const nextHeadingIndex = rest.search(/\n## /);
  const sectionBody = nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex);
  const afterSection = nextHeadingIndex === -1 ? '' : rest.slice(nextHeadingIndex);

  const trimmedBody = sectionBody.replace(/\s+$/, '');
  const newBody = trimmedBody === '' ? `\n\n${bullet}\n` : `${trimmedBody}\n${bullet}\n`;

  return content.slice(0, headingEnd) + newBody + afterSection;
}

/** Reads `USER.md` fresh on every call, so an edit applies to the next run (PRF-03). Missing file means no preferences. */
export class FileProfileStore implements UserPreferencesSource {
  constructor(private readonly userFile: string) {}

  async userPreferences(): Promise<string | null> {
    try {
      return await readFile(this.userFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** ADR-0020: appends one bullet under `## Learned`; never rewrites any other byte of the file. */
  async appendLearned(fact: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.userFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        content = '';
      } else {
        throw error;
      }
    }
    await writeFile(this.userFile, insertLearnedBullet(content, fact), 'utf8');
  }
}
