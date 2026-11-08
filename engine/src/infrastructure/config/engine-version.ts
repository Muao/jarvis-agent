import { readFileSync } from 'node:fs';

/** The `version` of `engine/package.json`, read once at start-up. */
export function readEngineVersion(
  packageJson: URL = new URL('../../../package.json', import.meta.url),
): string {
  const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown };
  return typeof version === 'string' ? version : 'unknown';
}
