import { RoleSchema, type Role } from '@jarvis/shared';

export interface McpEnv {
  readonly apiUrl: string;
  readonly runToken: string;
  readonly role: Role;
}

/** The environment `claude` hands to this process, as written into `mcp.json` by the engine. */
export function readMcpEnv(env: Readonly<Record<string, string | undefined>>): McpEnv {
  const apiUrl = env['JARVIS_API_URL'];
  const runToken = env['JARVIS_RUN_TOKEN'];
  if (!apiUrl) throw new Error('JARVIS_API_URL is not set.');
  if (!runToken) throw new Error('JARVIS_RUN_TOKEN is not set.');
  const role = RoleSchema.safeParse(env['JARVIS_ROLE']);
  if (!role.success) throw new Error('JARVIS_ROLE must be "dispatcher" or "worker".');
  return { apiUrl, runToken, role: role.data };
}
