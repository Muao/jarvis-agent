// Entry of the per-run Jarvis MCP server: `claude` starts it over stdio from the run's mcp.json (ADR-0004).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './api-client.js';
import { readMcpEnv } from './env.js';
import { createJarvisMcpServer } from './server.js';

async function main(): Promise<void> {
  const env = readMcpEnv(process.env);
  const api = createApiClient({ baseUrl: env.apiUrl, runToken: env.runToken });
  await createJarvisMcpServer({ role: env.role, api }).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout carries the protocol; diagnostics go to stderr and never include the token.
  process.stderr.write(`jarvis-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
