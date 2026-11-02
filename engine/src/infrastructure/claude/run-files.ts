import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolsByRole, type Role } from '@jarvis/shared';
import type { RunSpec } from '../../application/index.js';
import type { RunContext } from './run-context.js';

type Json = Record<string, unknown>;

/** Dispatcher runs plan and talk, they never change files (DSP-03). */
const DISPATCHER_SETTINGS = {
  permissions: {
    allow: ['Read', 'Glob', 'Grep', ...ownToolRules('dispatcher')],
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

export async function buildWorkerSettings(ctx: RunContext): Promise<Json> {
  const base = await readJson(join(ctx.agentDir, 'settings', 'worker.json'));
  const permissions = (base['permissions'] ?? {}) as Json;
  const { remote, baseBranch } = ctx.config.repo;
  return {
    ...base,
    permissions: {
      ...permissions,
      allow: unique([
        ...stringList(permissions['allow']),
        ...ctx.config.allowlist.autoAllowedCommands,
        ...ownToolRules('worker'),
      ]),
      deny: unique([...stringList(permissions['deny']), ...baseBranchDenies(remote, baseBranch)]),
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

async function readConnectors(ctx: RunContext): Promise<Json> {
  if (!ctx.connectorsFile) return {};
  let raw: Json;
  try {
    raw = await readJson(ctx.connectorsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const servers = substitute(raw['mcpServers'] ?? {}, ctx.connectorSecrets);
  return servers as Json;
}

export async function buildMcpConfig(spec: RunSpec, ctx: RunContext): Promise<Json> {
  const connectors = spec.role === 'worker' ? await readConnectors(ctx) : {};
  return {
    mcpServers: {
      ...connectors,
      jarvis: {
        command: ctx.mcpServer.command,
        args: [...ctx.mcpServer.args],
        env: {
          JARVIS_API_URL: ctx.apiUrl,
          JARVIS_RUN_TOKEN: spec.runToken,
          JARVIS_ROLE: spec.role,
        },
      },
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
