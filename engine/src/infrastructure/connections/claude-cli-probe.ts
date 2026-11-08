import type { Clock } from '../../application/ports/clock.js';
import { FORBIDDEN_BILLING_VARS, type EnvSource } from '../config/index.js';
import type { Exec } from './exec.js';
import { detail, type Probe } from './probe.js';

const TIMEOUT_MS = 8000;
const DAY_MS = 86_400_000;
/** Fewer days than this left on the login: the connection shows a warning. */
export const LOGIN_WARNING_DAYS = 7;

/** `ANTHROPIC_API_KEY` or a similar variable is set: the CLI would bill the API, not the subscription (SEC-05). */
export function billingVarsIn(env: EnvSource): string[] {
  return FORBIDDEN_BILLING_VARS.filter((name) => env[name] !== undefined && env[name] !== '');
}

interface AuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod: string | null;
  readonly subscriptionType: string | null;
  /** Epoch milliseconds; null when the CLI reports no usable expiry. */
  readonly loginExpiresAt: number | null;
}

/** Reads the JSON of `claude auth status`; only the fields shown, never the account email. */
function parseAuthStatus(stdout: string): AuthStatus | null {
  try {
    const json = JSON.parse(stdout) as Record<string, unknown>;
    const text = (key: string): string | null =>
      typeof json[key] === 'string' && json[key] !== '' ? (json[key] as string) : null;
    const expires = text('loginExpiresAt');
    const expiresMs = expires === null ? Number.NaN : Date.parse(expires);
    return {
      loggedIn: json['loggedIn'] === true,
      authMethod: text('authMethod'),
      subscriptionType: text('subscriptionType'),
      loginExpiresAt: Number.isNaN(expiresMs) ? null : expiresMs,
    };
  } catch {
    return null;
  }
}

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Claude CLI (CTX, SEC-05): the version from `claude --version` and the login from `claude auth status`.
 * Neither starts a model run, so a check costs nothing.
 */
export function claudeCliProbe(deps: {
  readonly binary: () => string;
  readonly exec: Exec;
  readonly env: EnvSource;
  readonly clock: Clock;
}): Probe {
  return async () => {
    const binary = deps.binary();
    const billing = billingVarsIn(deps.env);
    const version = await deps
      .exec(binary, ['--version'], { timeoutMs: TIMEOUT_MS })
      .catch(() => null);
    if (version === null || version.exitCode !== 0) {
      return {
        status: 'failed',
        summary: `Cannot run "${binary}". Install Claude Code or set engine.claudeBinary.`,
        details: [detail('Binary', binary)],
      };
    }
    const versionLine = version.stdout.trim().split('\n').at(-1) ?? 'unknown';
    const details = [detail('Version', versionLine)];

    if (billing.length > 0) {
      return {
        status: 'failed',
        summary: `${billing.join(', ')} ${billing.length > 1 ? 'are' : 'is'} set: runs would be billed to the API, not your subscription. Unset it and restart.`,
        details: [...details, detail('Billing variables', billing.join(', '))],
      };
    }

    const auth = parseAuthStatus(
      (
        await deps
          .exec(binary, ['auth', 'status', '--json'], { timeoutMs: TIMEOUT_MS })
          .catch(() => null)
      )?.stdout ?? '',
    );
    if (auth === null) {
      return {
        status: 'ok',
        summary: 'Installed; this version cannot report the login state.',
        details,
      };
    }
    if (!auth.loggedIn) {
      return {
        status: 'failed',
        summary: 'Not logged in. Run `claude auth login`.',
        details,
      };
    }
    const plan = auth.subscriptionType === null ? null : capitalise(auth.subscriptionType);
    const loginDetails = [
      ...details,
      detail('Login', auth.authMethod ?? 'unknown'),
      ...(plan === null ? [] : [detail('Plan', plan)]),
    ];
    if (auth.authMethod !== null && auth.authMethod !== 'claude.ai') {
      return {
        status: 'failed',
        summary: `Logged in with ${auth.authMethod}, not a subscription: runs would be billed to the API.`,
        subscription: false,
        details: loginDetails,
      };
    }
    const subscription = auth.authMethod === 'claude.ai' ? true : null;
    const loggedIn = plan === null ? 'Logged in' : `Logged in · ${plan}`;
    if (auth.loginExpiresAt === null) {
      return { status: 'ok', summary: loggedIn, subscription, details: loginDetails };
    }
    const expiresOn = new Date(auth.loginExpiresAt).toISOString().slice(0, 10);
    const msLeft = auth.loginExpiresAt - Date.parse(deps.clock.now());
    if (msLeft <= 0) {
      return {
        status: 'failed',
        summary: `Login expired on ${expiresOn}. Run \`claude\` and /login.`,
        subscription,
        loginExpired: true,
        details: [...loginDetails, detail('Expired', expiresOn)],
      };
    }
    if (msLeft < LOGIN_WARNING_DAYS * DAY_MS) {
      const days = Math.max(1, Math.floor(msLeft / DAY_MS));
      return {
        status: 'warning',
        summary: `Login expires in ${days} ${days === 1 ? 'day' : 'days'}`,
        subscription,
        details: [...loginDetails, detail('Expires', expiresOn)],
      };
    }
    return {
      status: 'ok',
      summary: loggedIn,
      subscription,
      details: [...loginDetails, detail('Expires', expiresOn)],
    };
  };
}
