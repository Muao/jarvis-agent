import type { JarvisConfig } from '@jarvis/shared';

/**
 * Where one run's files live and how its MCP server is started. The composition root builds it
 * per run (config is re-read on change; a run keeps the values it started with).
 */
export interface RunContext {
  /** `<repo>/agent`: the plugin (ADR-0009). */
  readonly agentDir: string;
  /**
   * `~/.jarvis/plugin`: the owner's own skills and subagents (ADR-0025). Always set, because a
   * worker is denied writing there even before the plugin exists.
   */
  readonly ownerPluginDir?: string;
  /** True when `ownerPluginDir` is a plugin (has `.claude-plugin/plugin.json`): every run loads it after `agentDir`. */
  readonly ownerPluginPresent?: boolean;
  /** `~/.jarvis/runs/<runId>`: holds `system.md`, `mcp.json`, `settings.json`. */
  readonly runDir: string;
  readonly config: Pick<JarvisConfig, 'repo' | 'allowlist' | 'telemetry' | 'ui'>;
  /** How to start the Jarvis MCP server (the composition root knows the node and tsx paths). */
  readonly mcpServer: { readonly command: string; readonly args: readonly string[] };
  /** Base URL of the engine API, for example `http://127.0.0.1:4310`. */
  readonly apiUrl: string;
  /** `~/.jarvis/mcp/servers.json`; connector servers are added for workers when it exists. */
  readonly connectorsFile?: string;
  /** Values for `${VAR}` placeholders in the connectors file (ADR-0015). */
  readonly connectorSecrets: Readonly<Record<string, string | undefined>>;
}
