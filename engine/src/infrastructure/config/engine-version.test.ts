import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readEngineVersion } from './engine-version.js';

describe('readEngineVersion', () => {
  it('returns the version engine/package.json actually contains', () => {
    const file = new URL('../../../package.json', import.meta.url);
    const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version: string };

    expect(readEngineVersion()).toBe(version);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('falls back to unknown when the file has no version', () => {
    const file = new URL('../../../tsconfig.json', import.meta.url);

    expect(readEngineVersion(file)).toBe('unknown');
  });
});
