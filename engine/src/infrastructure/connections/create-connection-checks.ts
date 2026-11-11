import type { ClaudeAiConnector } from '@jarvis/shared';
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

/** ADR-0027: the connector comes from the owner's claude.ai account, and runs may only read it. */
const CLAUDE_AI_MODE = detail('Mode', 'claude.ai connector, read-only');

/** The Connections screen's probes (CTX-01…CTX-05, SEC-04, SEC-05) behind the `ConnectionChecks` port. */
export function createConnectionChecks(options: ConnectionChecksOptions): ConnectionChecks {
  const { config, env } = options;
  const viaClaudeAi = (id: ClaudeAiConnector): boolean =>
    config.current().connectors.claudeAi.includes(id);
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
        if (viaClaudeAi('notion')) {
          return {
            missing: [],
            details: [CLAUDE_AI_MODE, ...(root ? [detail('Root page', root)] : [])],
          };
        }
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
        if (viaClaudeAi('google_docs') || viaClaudeAi('google_drive')) {
          return {
            missing: [],
            details: [CLAUDE_AI_MODE, ...(folder ? [detail('Folder', folder)] : [])],
          };
        }
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
      // ADR-0006: Slack as the owner's channel is iteration 2. ADR-0027: as a source it can be read now.
      slack: async () =>
        viaClaudeAi('slack')
          ? connectorProbe(() => ({ missing: [], details: [CLAUDE_AI_MODE] }))()
          : fixedProbe('disabled', 'Iteration 2.')(),
    },
  });
}
