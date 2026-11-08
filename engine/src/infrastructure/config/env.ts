import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LogLevel } from '../logging/console-logger.js';
import { StartupError } from './startup-error.js';

/** The only environment the engine reads (ADR-0015). */
export interface JarvisEnv {
  readonly jarvisHome: string;
  readonly databaseUrl: string;
  /** Interface the API binds to; loopback unless the runtime image sets `JARVIS_LISTEN_HOST` (ADR-0016). */
  readonly listenHost: string;
  /**
   * Lowest severity of the application's own JSON lines (lifecycle events, warnings, errors); `JARVIS_LOG_LEVEL`,
   * default `info` (ADR-0016). Fastify's request log is configured separately in main.ts.
   */
  readonly logLevel: LogLevel;
  /** Healthchecks.io style ping URL; it carries a token, so it is a secret. Absent: no heartbeat (ADR-0016). */
  readonly heartbeatUrl?: string;
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

/**
 * The child `claude` reaches the API over 127.0.0.1 (container.ts), so only hosts that serve it are allowed;
 * `localhost` is normalized to 127.0.0.1 because it can resolve to `::1`, which the child cannot reach.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const isLoopback = (host: string): boolean => LOOPBACK_HOSTS.has(host);

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info'];

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
  const requestedHost = nonEmpty(source['JARVIS_LISTEN_HOST']) ?? '127.0.0.1';
  const listenHost = requestedHost === 'localhost' ? '127.0.0.1' : requestedHost;
  if (!isLoopback(requestedHost) && nonEmpty(source['JARVIS_INSIDE_CONTAINER']) !== '1') {
    throw new StartupError(
      `Refusing to start: JARVIS_LISTEN_HOST=${requestedHost} is not allowed here: it is either exposed beyond this machine or not reachable at 127.0.0.1. ` +
        'Allowed values are 127.0.0.1 and localhost, because the child claude reaches the API over 127.0.0.1. ' +
        'Engine, web and Postgres must be reachable only over loopback and the tailnet (ADR-0016). ' +
        'Unset JARVIS_LISTEN_HOST (check your shell profile and ~/.jarvis/.env) to bind 127.0.0.1; ' +
        'only the runtime container sets it, together with JARVIS_INSIDE_CONTAINER=1 (ADR-0016).',
    );
  }
  const requestedLevel = nonEmpty(source['JARVIS_LOG_LEVEL']) ?? 'info';
  const logLevel = LOG_LEVELS.find((level) => level === requestedLevel);
  if (logLevel === undefined) {
    throw new StartupError(
      `JARVIS_LOG_LEVEL=${requestedLevel} is not valid. Use one of ${LOG_LEVELS.join(', ')} ` +
        '(default info), or unset it in ~/.jarvis/.env.',
    );
  }
  const heartbeatUrl = nonEmpty(source['HEARTBEAT_URL']);
  if (heartbeatUrl !== undefined && !isHttpUrl(heartbeatUrl)) {
    // The value is never echoed: the token is in it.
    throw new StartupError(
      'HEARTBEAT_URL is not a valid http(s) URL. Fix it in ~/.jarvis/.env, or unset it to run without a heartbeat.',
    );
  }
  return {
    jarvisHome: nonEmpty(source['JARVIS_HOME']) ?? join(homedir(), '.jarvis'),
    databaseUrl,
    listenHost,
    logLevel,
    ...(heartbeatUrl !== undefined ? { heartbeatUrl } : {}),
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
