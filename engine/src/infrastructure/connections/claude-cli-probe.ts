import { FORBIDDEN_BILLING_VARS, type EnvSource } from '../config/index.js';
import type { Exec } from './exec.js';
import { detail, type Probe } from './probe.js';

const TIMEOUT_MS = 8000;

/** `ANTHROPIC_API_KEY` or a similar variable is set: the CLI would bill the API, not the subscription (SEC-05). */
export function billingVarsIn(env: EnvSource): string[] {
  return FORBIDDEN_BILLING_VARS.filter((name) => env[name] !== undefined && env[name] !== '');
}

interface AuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod: string | null;
  readonly subscriptionType: string | null;
}

/** Reads the JSON of `claude auth status`; only the three fields shown, never the account email. */
function parseAuthStatus(stdout: string): AuthStatus | null {
  try {
    const json = JSON.parse(stdout) as Record<string, unknown>;
    const text = (key: string): string | null =>
      typeof json[key] === 'string' && json[key] !== '' ? (json[key] as string) : null;
    return {
      loggedIn: json['loggedIn'] === true,
      authMethod: text('authMethod'),
      subscriptionType: text('subscriptionType'),
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
    return {
      status: 'ok',
      summary: plan === null ? 'Logged in' : `Logged in · ${plan}`,
      subscription: auth.authMethod === 'claude.ai' ? true : null,
      details: loginDetails,
    };
  };
}
