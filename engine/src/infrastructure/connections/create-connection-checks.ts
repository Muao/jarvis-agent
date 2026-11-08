import type { Clock } from '../../application/ports/clock.js';
import type { ConfigProvider } from '../../application/ports/config-provider.js';
import type { ConnectionChecks } from '../../application/ports/connection-checks.js';
import { buildChildEnv } from '../claude/child-env.js';
import type { EnvSource } from '../config/index.js';
import type { ConnectionChecker } from '../github/index.js';
import { billingVarsIn, claudeCliProbe } from './claude-cli-probe.js';
import { connectorProbe, fixedProbe } from './connector-probe.js';
import { execFileWith, type Exec } from './exec.js';
import { githubProbe } from './github-probe.js';
import { detail } from './probe.js';
import { ProbedConnectionChecks } from './probed-connection-checks.js';

export interface ConnectionChecksOptions {
  readonly config: ConfigProvider;
  readonly env: EnvSource;
  /** The GitHub code host; null when `GITHUB_TOKEN` is not set. */
  readonly github: ConnectionChecker | null;
  readonly clock: Clock;
  readonly exec?: Exec;
  readonly timeoutMs?: number;
}

const present = (value: string | undefined): boolean => value !== undefined && value !== '';

/** The variables the Google Drive MCP server reads in external-token mode (docs/architecture/connectors.md). */
const GOOGLE_VARS = [
  'GOOGLE_DRIVE_MCP_REFRESH_TOKEN',
  'GOOGLE_DRIVE_MCP_CLIENT_ID',
  'GOOGLE_DRIVE_MCP_CLIENT_SECRET',
] as const;

/** The Connections screen's probes (CTX-01…CTX-05, SEC-04, SEC-05) behind the `ConnectionChecks` port. */
export function createConnectionChecks(options: ConnectionChecksOptions): ConnectionChecks {
  const { config, env } = options;
  const exec = options.exec ?? execFileWith(buildChildEnv(env, { role: 'dispatcher' }));
  return new ProbedConnectionChecks({
    billingEnvDetected: () => billingVarsIn(env).length > 0,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    probes: {
      claude: claudeCliProbe({
        binary: () => config.current().engine.claudeBinary,
        exec,
        env,
        clock: options.clock,
      }),
      github: githubProbe(options.github),
      notion: connectorProbe(() => {
        const root = config.current().connectors.notionRoot;
        return {
          missing: [
            ...(present(env['NOTION_TOKEN']) ? [] : ['NOTION_TOKEN']),
            ...(root === undefined ? ['connectors.notionRoot'] : []),
          ],
          details: root === undefined ? [] : [detail('Root page', root)],
        };
      }),
      google_docs: connectorProbe(() => {
        const folder = config.current().connectors.googleFolder;
        // Credential (env) and target (config folder) are reported together, so a half-configured
        // connector names the half that is missing.
        return {
          missing: [
            ...GOOGLE_VARS.filter((name) => !present(env[name])),
            ...(folder === undefined ? ['connectors.googleFolder'] : []),
          ],
          details: [
            detail('Mode', 'OAuth refresh token from environment'),
            ...(folder === undefined ? [] : [detail('Folder', folder)]),
          ],
        };
      }),
      claude_design: fixedProbe('not_configured', 'Design handoff is manual in iteration 1.'),
      slack: fixedProbe('disabled', 'Iteration 2.'),
    },
  });
}
