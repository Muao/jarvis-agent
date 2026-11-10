import type { McpServerItem } from '@jarvis/shared';
import type { RunContext } from './run-context.js';
import {
  jarvisServer,
  playwrightEnabled,
  playwrightServer,
  readRawConnectors,
} from './run-files.js';

type Json = Record<string, unknown>;
type McpListingContext = Pick<RunContext, 'config' | 'mcpServer' | 'apiUrl' | 'connectorsFile'>;

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SECRETISH = /token|secret|key|password|passwd|auth|credential/i;
const MASK = '***';

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** `--token abc` and `--api-key=abc`: whatever follows a secret-looking flag is masked. */
function maskArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      out.push(arg.includes('${') ? arg : MASK);
      maskNext = false;
      continue;
    }
    const flag = /^(--?[A-Za-z][\w-]*)(=(.*))?$/.exec(arg);
    if (flag !== null && SECRETISH.test(flag[1] as string)) {
      if (flag[2] === undefined) maskNext = true;
      out.push(
        flag[2] === undefined || (flag[3] ?? '').includes('${')
          ? arg
          : `${flag[1] as string}=${MASK}`,
      );
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** The address without credentials, query or fragment: those are where tokens end up. */
function safeUrl(value: string): string {
  if (value.includes('${')) return value.split(/[?#]/)[0] ?? value;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value.split(/[?#]/)[0] ?? value;
  }
}

/** The names of the variables a server entry is given or refers to — never a value. */
function envVarNames(entry: Json): string[] {
  const names = new Set<string>();
  const env = entry['env'];
  if (env !== null && typeof env === 'object') {
    for (const key of Object.keys(env)) names.add(key);
  }
  for (const match of JSON.stringify(entry).matchAll(PLACEHOLDER)) names.add(match[1] as string);
  return [...names].sort();
}

function describe(
  name: string,
  source: McpServerItem['source'],
  roles: McpServerItem['roles'],
  entry: Json,
): McpServerItem {
  const command = typeof entry['command'] === 'string' ? entry['command'] : undefined;
  const url = typeof entry['url'] === 'string' ? safeUrl(entry['url']) : undefined;
  const type = typeof entry['type'] === 'string' ? entry['type'] : undefined;
  const args = maskArgs(stringList(entry['args']));
  return {
    name,
    source,
    roles,
    transport: type ?? (url === undefined ? 'stdio' : 'http'),
    ...(command === undefined ? {} : { command }),
    ...(args.length === 0 ? {} : { args }),
    ...(url === undefined ? {} : { url }),
    envVars: envVarNames(entry),
  };
}

/**
 * ADR-0025: what `buildMcpConfig` would put into a run's `mcp.json`, described without values. The
 * built-ins come from the same functions that build the file; connectors are read as written, so
 * `${VAR}` stays a name and is never substituted. Roles follow `buildMcpConfig`: connectors and the
 * browser are worker tools (a `ui_check` run is a worker run).
 */
export async function listMcpServers(ctx: McpListingContext): Promise<McpServerItem[]> {
  const servers: McpServerItem[] = [
    describe(
      'jarvis',
      'builtin',
      ['dispatcher', 'worker', 'ui_check'],
      jarvisServer(ctx, 'worker', ''),
    ),
  ];
  if (playwrightEnabled('worker', ctx, 'screenshots')) {
    servers.push(
      describe(
        'playwright',
        'builtin',
        ['worker', 'ui_check'],
        playwrightServer(ctx, 'screenshots'),
      ),
    );
  }
  let connectors: Record<string, Json> = {};
  try {
    connectors = await readRawConnectors(ctx);
  } catch {
    // A servers.json that does not parse is the owner's to fix; the page still lists the rest.
  }
  for (const [name, entry] of Object.entries(connectors)) {
    servers.push(describe(name, 'connector', ['worker', 'ui_check'], entry));
  }
  return servers;
}
