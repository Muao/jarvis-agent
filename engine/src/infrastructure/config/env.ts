import { homedir } from 'node:os';
import { join } from 'node:path';
import { StartupError } from './startup-error.js';

/** The only environment the engine reads (ADR-0007). */
export interface JarvisEnv {
  readonly jarvisHome: string;
  readonly databaseUrl: string;
  readonly githubToken?: string;
  readonly notionToken?: string;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Variables that would make `claude` bill the API instead of the subscription (SEC-05, CON-01). */
export const FORBIDDEN_BILLING_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** `process.env` is read here and in main.ts only (architecture test). */
export function loadEnv(source: EnvSource = process.env): JarvisEnv {
  const databaseUrl = nonEmpty(source['DATABASE_URL']);
  if (!databaseUrl) {
    throw new StartupError(
      'DATABASE_URL is not set. Add it to ~/.jarvis/.env (see .env.example), for example ' +
        'DATABASE_URL=postgres://jarvis:jarvis@127.0.0.1:5433/jarvis, and start Postgres with `docker compose up -d`.',
    );
  }
  const githubToken = nonEmpty(source['GITHUB_TOKEN']);
  const notionToken = nonEmpty(source['NOTION_TOKEN']);
  return {
    jarvisHome: nonEmpty(source['JARVIS_HOME']) ?? join(homedir(), '.jarvis'),
    databaseUrl,
    ...(githubToken !== undefined ? { githubToken } : {}),
    ...(notionToken !== undefined ? { notionToken } : {}),
  };
}

/** Refuses to start when an API-billing variable is present (SEC-05, CON-01). Checks presence, not value. */
export function assertSubscriptionOnly(source: EnvSource = process.env): void {
  const present = FORBIDDEN_BILLING_VARS.filter(
    (name) => source[name] !== undefined && source[name] !== '',
  );
  if (present.length === 0) return;
  throw new StartupError(
    `Refusing to start: ${present.join(', ')} ${present.length > 1 ? 'are' : 'is'} set. ` +
      'Jarvis runs on your Claude subscription, and with this variable every run would be billed to the API instead. ' +
      `Unset ${present.length > 1 ? 'them' : 'it'} (check your shell profile and ~/.jarvis/.env), ` +
      'log in once with `claude`, and start the engine again.',
  );
}
