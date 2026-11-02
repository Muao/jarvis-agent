import type { ConnectionChecker } from '../github/index.js';
import { detail, type Probe } from './probe.js';

/**
 * GitHub (CI-03, ADM-08): who the token is, whether it reaches the working repository and what it may do.
 * `null` means no token is configured. The token never leaves the code host; only its owner's login does.
 */
export function githubProbe(host: ConnectionChecker | null): Probe {
  return async () => {
    if (host === null) {
      return {
        status: 'not_configured',
        summary: 'GITHUB_TOKEN is not set in ~/.jarvis/.env.',
        details: [],
      };
    }
    const status = await host.checkConnection();
    const details = [
      detail('Account', status.login),
      detail('Repository access', status.repoAccess ? 'yes' : 'no'),
      detail(
        'Permissions',
        status.permissions.length > 0 ? status.permissions.join(', ') : 'unknown',
      ),
      detail('Token expires', status.expiresAt ?? 'never'),
    ];
    return status.repoAccess
      ? { status: 'ok', summary: `Connected as ${status.login}`, details }
      : {
          status: 'failed',
          summary: `${status.login} cannot access the working repository. Check the token's repository access.`,
          details,
        };
  };
}
