import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolsByRole, type Role } from '@jarvis/shared';
import type { RunSpec } from '../../application/index.js';
import type { RunContext } from './run-context.js';

type Json = Record<string, unknown>;

/** Dispatcher runs plan and talk, they never change files (DSP-03). The web is read without asking. */
const DISPATCHER_SETTINGS = {
  permissions: {
    allow: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', ...ownToolRules('dispatcher')],
    deny: ['Edit', 'Write', 'Bash', 'NotebookEdit'],
  },
};

/** A role's own Jarvis tools never need owner approval; `approve` is the approval path itself. */
function ownToolRules(role: Role): string[] {
  return toolsByRole[role]
    .filter((tool) => tool !== 'approve')
    .map((tool) => `mcp__jarvis__${tool}`);
}

const unique = (items: readonly string[]): string[] => [...new Set(items)];

/** ADR-0014: pinned, because `@latest` in an agent runtime makes a run non-reproducible. */
export const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.84';

/**
 * The Playwright release `PLAYWRIGHT_MCP` depends on. A browser build belongs to one revision, so
 * the runtime image must install chromium from this exact release or the MCP server cannot launch
 * the browser it finds. `docker/runtime/Dockerfile` installs it; a test holds the two together.
 */
export const PLAYWRIGHT_BROWSER_VERSION = '1.65.0-alpha-2026-10-30';

/**
 * ADR-0014: what the `ui-tester` subagent may do in the browser. Everything that drives the UI
 * the way a person would, plus what it needs to read console and network.
 */
export const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_hover',
  'browser_select_option',
  'browser_drag',
  'browser_drop',
  'browser_find',
  'browser_wait_for',
  'browser_resize',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_close',
  'browser_emulate_media',
  // Picking a file is something a person does in a form. Denying it did not make the check safer,
  // it made it shallower: a cover image, an avatar or an import is simply unreachable, and the
  // worker ends up recreating the record through the API, which proves nothing about the form
  // (T-6 on quick-blog PR #38, 2026-11-09).
  'browser_file_upload',
] as const;

/**
 * Arbitrary page JavaScript, and only that. Both of these let the agent reach past the interface
 * and satisfy a scenario without the interface working — calling a click handler directly proves
 * nothing about the button. Everything a person can do with a mouse and a keyboard, including
 * choosing a file, stays allowed: the line is "did the user interface do it", not "is the tool
 * powerful".
 */
export const BROWSER_DENIED_TOOLS = ['browser_evaluate', 'browser_run_code_unsafe'] as const;

export const playwrightToolName = (tool: string): string => `mcp__playwright__${tool}`;

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'] as const;

/** The Playwright MCP server for one worker run: headless, profile-less, pinned to the dev server. */
export function playwrightServer(
  ctx: Pick<RunContext, 'config' | 'apiUrl'>,
  screenshotsDir: string,
): Json {
  const { ui } = ctx.config;
  const enginePort = new URL(ctx.apiUrl).port;
  // ADR-0026: the ports of the app are chosen by the plan, after this server has started, so the
  // allow-list is "this machine, any port" — and the engine's own API is taken back out of it.
  // Playwright MCP takes **semicolon**-separated lists and evaluates the block-list first.
  const origins = LOOPBACK_HOSTS.map((host) => `http://${host}:*`).join(';');
  const blocked = LOOPBACK_HOSTS.map((host) => `http://${host}:${enginePort}`).join(';');
  return {
    command: 'npx',
    args: [
      '-y',
      PLAYWRIGHT_MCP,
      '--headless',
      '--isolated',
      '--browser',
      'chromium',
      '--viewport-size',
      '1280x800',
      '--output-dir',
      screenshotsDir,
      // A brake, not a boundary: Playwright MCP says so itself, and it does not cover redirects.
      '--allowed-origins',
      origins,
      '--blocked-origins',
      blocked,
      '--console-level',
      'error',
      '--idle-timeout',
      '300000',
      '--timeout-action',
      '5000',
      '--timeout-navigation',
      '15000',
      '--image-responses',
      'allow',
      // A page must not be able to register tools for the agent (SOUL principle 4).
      '--no-webmcp',
      '--save-session',
      ...(ui.noSandbox ? ['--no-sandbox'] : []),
    ],
  };
}

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, 'utf8')) as Json;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Denies the engine adds on top of `agent/settings/worker.json` (SEC-01, SEC-02). */
function baseBranchDenies(remote: string, baseBranch: string): string[] {
  return [
    `Bash(git push ${remote} ${baseBranch}:*)`,
    `Bash(git push -u ${remote} ${baseBranch}:*)`,
    `Bash(git push ${remote} HEAD:${baseBranch}:*)`,
    `Bash(git push ${remote} HEAD:refs/heads/${baseBranch}:*)`,
    `Bash(git push ${remote} *:${baseBranch}:*)`,
    // Delete by refspec: `git push <remote> :<branch>`.
    `Bash(git push ${remote} :*)`,
    `Bash(git push ${remote} +*)`,
    'Bash(gh pr merge:*)',
  ];
}

/**
 * ADR-0025: a worker reads untrusted text all day, so it may not rewrite the instructions the next
 * run starts with. `//` is how a permission rule names an absolute path.
 */
function ownerPluginDenies(ctx: RunContext): string[] {
  if (ctx.ownerPluginDir === undefined) return [];
  const path = `/${ctx.ownerPluginDir.replace(/\/+$/, '')}/**`;
  return [`Edit(${path})`, `Write(${path})`];
}

export async function buildWorkerSettings(ctx: RunContext): Promise<Json> {
  const base = await readJson(join(ctx.agentDir, 'settings', 'worker.json'));
  const permissions = (base['permissions'] ?? {}) as Json;
  const { remote, baseBranch } = ctx.config.repo;
  const browserAllow = ctx.config.ui.enabled ? BROWSER_TOOLS.map(playwrightToolName) : [];
  return {
    ...base,
    permissions: {
      ...permissions,
      allow: unique([
        ...stringList(permissions['allow']),
        ...ctx.config.allowlist.autoAllowedCommands,
        ...ownToolRules('worker'),
        ...browserAllow,
      ]),
      deny: unique([
        ...stringList(permissions['deny']),
        ...baseBranchDenies(remote, baseBranch),
        ...BROWSER_DENIED_TOOLS.map(playwrightToolName),
        ...ownerPluginDenies(ctx),
      ]),
    },
  };
}

/** `agent/SOUL.md` followed by the role prompt: the CLI takes a single system prompt file. */
export async function buildSystemPrompt(ctx: RunContext, role: RunSpec['role']): Promise<string> {
  const soul = await readFile(join(ctx.agentDir, 'SOUL.md'), 'utf8');
  const prompt = await readFile(join(ctx.agentDir, 'prompts', `${role}.md`), 'utf8');
  return `${soul.trimEnd()}\n\n${prompt.trimEnd()}\n`;
}

function substitute(value: unknown, secrets: RunContext['connectorSecrets']): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, name: string) => secrets[name] ?? '',
    );
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, substitute(v, secrets)]),
    );
  }
  return value;
}

/** The connector servers exactly as written in `servers.json`: `${VAR}` placeholders untouched. */
export async function readRawConnectors(
  ctx: Pick<RunContext, 'connectorsFile'>,
): Promise<Record<string, Json>> {
  if (!ctx.connectorsFile) return {};
  let raw: Json;
  try {
    raw = await readJson(ctx.connectorsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return (raw['mcpServers'] ?? {}) as Record<string, Json>;
}

async function readConnectors(ctx: RunContext): Promise<Json> {
  return substitute(await readRawConnectors(ctx), ctx.connectorSecrets) as Json;
}

/** The engine's own MCP server (ADR-0004): how to start it and what it is told about the run. */
export function jarvisServer(
  ctx: Pick<RunContext, 'mcpServer' | 'apiUrl'>,
  role: RunSpec['role'],
  runToken: string,
): Json {
  return {
    command: ctx.mcpServer.command,
    args: [...ctx.mcpServer.args],
    env: {
      JARVIS_API_URL: ctx.apiUrl,
      JARVIS_RUN_TOKEN: runToken,
      JARVIS_ROLE: role,
    },
  };
}

/** ADR-0014: the browser is a worker tool, and only when the owner turned the UI check on. */
export function playwrightEnabled(
  role: RunSpec['role'],
  ctx: Pick<RunContext, 'config'>,
  screenshotsDir: string | undefined,
): boolean {
  return role === 'worker' && ctx.config.ui.enabled && screenshotsDir !== undefined;
}

export async function buildMcpConfig(spec: RunSpec, ctx: RunContext): Promise<Json> {
  const connectors = spec.role === 'worker' ? await readConnectors(ctx) : {};
  const playwright = playwrightEnabled(spec.role, ctx, spec.screenshotsDir)
    ? { playwright: playwrightServer(ctx, spec.screenshotsDir as string) }
    : {};
  return {
    mcpServers: {
      ...connectors,
      ...playwright,
      jarvis: jarvisServer(ctx, spec.role, spec.runToken),
    },
  };
}

/** Writes `system.md`, `mcp.json` and `settings.json` into the (existing) run directory. */
export async function writeRunFiles(runDir: string, spec: RunSpec, ctx: RunContext): Promise<void> {
  const settings = spec.role === 'worker' ? await buildWorkerSettings(ctx) : DISPATCHER_SETTINGS;
  const [system, mcp] = await Promise.all([
    buildSystemPrompt(ctx, spec.role),
    buildMcpConfig(spec, ctx),
  ]);
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  // mcp.json holds the run token: owner-only.
  await Promise.all([
    writeFile(join(runDir, 'system.md'), system),
    writeFile(join(runDir, 'settings.json'), json(settings)),
    writeFile(join(runDir, 'mcp.json'), json(mcp), { mode: 0o600 }),
  ]);
}
