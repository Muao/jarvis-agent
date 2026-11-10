import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities, CapabilityItem, CapabilitySource, McpServerItem } from '@jarvis/shared';
import type { CapabilityCatalog } from '../../application/index.js';
import { listField, parseFrontmatter, textField } from './frontmatter.js';

export interface FileCapabilityCatalogOptions {
  /** `<repo>/agent`: built-in skills and subagents. */
  readonly agentDir: string;
  /** `~/.jarvis/plugin`: the owner's own. */
  readonly ownerPluginDir: string;
  /** `~/.jarvis/repos`: clones live in `<owner>/<name>` below it (ADR-0012). */
  readonly reposRoot: string;
  /** `repos.allow`, read at each call: it hot-reloads. */
  readonly allowedRepos: () => readonly string[];
  /** MCP servers, built by the same code that builds `mcp.json`. */
  readonly mcpServers: () => Promise<McpServerItem[]>;
}

interface Origin {
  readonly source: CapabilitySource;
  readonly repo?: string;
  /** Directory holding `agents/` and `skills/` (or, for a repo, `agents/` and `skills/` under `.claude`). */
  readonly dir: string;
}

async function entries(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // Not there (repo not cloned, no owner plugin yet, no skills folder): nothing to list.
    return [];
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function item(
  origin: Origin,
  fallbackName: string,
  text: string,
  isAgent: boolean,
): CapabilityItem {
  const parsed = parseFrontmatter(text);
  const fields = parsed?.fields ?? {};
  const name = textField(fields['name']) ?? fallbackName;
  const model = isAgent ? textField(fields['model']) : undefined;
  const tools = isAgent ? listField(fields['tools']) : undefined;
  return {
    name,
    description: textField(fields['description']) ?? '',
    source: origin.source,
    ...(origin.repo === undefined ? {} : { repo: origin.repo }),
    ...(model === undefined ? {} : { model }),
    ...(tools === undefined ? {} : { tools }),
    editable: origin.source === 'owner',
  };
}

async function agentsOf(origin: Origin): Promise<CapabilityItem[]> {
  const files = (await entries(join(origin.dir, 'agents')))
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
  const items: CapabilityItem[] = [];
  for (const file of files) {
    const text = await readText(join(origin.dir, 'agents', file));
    if (text !== null) items.push(item(origin, file.slice(0, -3), text, true));
  }
  return items;
}

async function skillsOf(origin: Origin): Promise<CapabilityItem[]> {
  const dirs = (await entries(join(origin.dir, 'skills')))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const items: CapabilityItem[] = [];
  for (const dir of dirs) {
    const text = await readText(join(origin.dir, 'skills', dir, 'SKILL.md'));
    if (text !== null) items.push(item(origin, dir, text, false));
  }
  return items;
}

/** Owner and repo are path segments: anything else in `repos.allow` is skipped, not followed. */
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * ADR-0025: reads skills and subagents from the built-in plugin, the owner's plugin and the
 * allow-listed repos that are cloned here (a repo that is not cloned simply has none to show).
 */
export class FileCapabilityCatalog implements CapabilityCatalog {
  constructor(private readonly options: FileCapabilityCatalogOptions) {}

  async list(): Promise<Capabilities> {
    const origins: Origin[] = [
      { source: 'builtin', dir: this.options.agentDir },
      { source: 'owner', dir: this.options.ownerPluginDir },
      ...this.options
        .allowedRepos()
        .filter((slug) => SAFE_REPO.test(slug))
        .map((slug): Origin => {
          const [owner = '', name = ''] = slug.split('/');
          return {
            source: 'repo',
            repo: slug,
            dir: join(this.options.reposRoot, owner, name, '.claude'),
          };
        }),
    ];
    const [skills, agents, mcpServers] = await Promise.all([
      Promise.all(origins.map(skillsOf)),
      Promise.all(origins.map(agentsOf)),
      this.options.mcpServers(),
    ]);
    return { skills: skills.flat(), agents: agents.flat(), mcpServers };
  }
}
