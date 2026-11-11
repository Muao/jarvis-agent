import { describe, expect, it } from 'vitest';
import { uiFilesIn } from './ui-paths.js';

describe('uiFilesIn', () => {
  const globs = ['**/*.tsx', '**/*.css', 'public/*.html', 'app/**'];

  it('keeps the files a glob matches, at any depth', () => {
    expect(
      uiFilesIn(
        ['App.tsx', 'web/src/a/B.tsx', 'web/a.css', 'public/index.html', 'app/x/y.ts', 'src/a.ts'],
        globs,
      ),
    ).toEqual(['App.tsx', 'web/src/a/B.tsx', 'web/a.css', 'public/index.html', 'app/x/y.ts']);
  });

  it('does not let * cross a directory or a dot match any character', () => {
    expect(uiFilesIn(['public/a/index.html', 'src/atsx', 'a.tsx.bak'], globs)).toEqual([]);
  });
});
