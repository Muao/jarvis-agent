import type { Role } from '@jarvis/shared';
import type { EnvSource } from '../config/index.js';

/**
 * The only variables a child `claude` inherits (ADR-0004, ADR-0007). Everything else, in particular
 * `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `DATABASE_URL` and `SLACK_*`, is dropped by construction.
 * `CLAUDE_CONFIG_DIR` and `USER` select the owner's subscription login: without them the CLI falls
 * back to the default config dir, which may authenticate with an API key helper instead (SEC-05).
 */
const INHERITED = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'SHELL',
  'TMPDIR',
  'CLAUDE_CONFIG_DIR',
] as const;

export function buildChildEnv(
  source: EnvSource,
  options: { readonly role: Role; readonly githubToken?: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (options.role === 'worker' && options.githubToken) env['GH_TOKEN'] = options.githubToken;
  return env;
}
