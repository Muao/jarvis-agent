import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CapabilityKind, OwnerAgentInput, OwnerCapabilityDoc } from '@jarvis/shared';
import type { OwnerCapabilityInput, OwnerPluginStore } from '../../application/index.js';
import { listField, parseFrontmatter, serializeFrontmatter, textField } from './frontmatter.js';

export const OWNER_PLUGIN_NAME = 'jarvis-owner';
const DEFAULT_BACKUPS_KEPT = 20;

export interface FileOwnerPluginStoreOptions {
  /** `~/.jarvis/plugin`. */
  readonly pluginDir: string;
  /** `~/.jarvis/plugin-backups`. */
  readonly backupsDir: string;
  /** How many backups to keep across all items. */
  readonly backupsKept?: number | (() => number);
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * ADR-0025: the owner's own plugin on disk — `plugin.json`, `skills/<name>/SKILL.md` and
 * `agents/<name>.md`. Writes go through one queue and replace the file by renaming a temporary
 * one over it; the previous version is copied to the backups folder first.
 */
export class FileOwnerPluginStore implements OwnerPluginStore {
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;

  constructor(private readonly options: FileOwnerPluginStoreOptions) {}

  private fileOf(kind: CapabilityKind, name: string): string {
    return kind === 'skills'
      ? join(this.options.pluginDir, 'skills', name, 'SKILL.md')
      : join(this.options.pluginDir, 'agents', `${name}.md`);
  }

  async get(kind: CapabilityKind, name: string): Promise<OwnerCapabilityDoc | null> {
    const markdown = await readOrNull(this.fileOf(kind, name));
    if (markdown === null) return null;
    const parsed = parseFrontmatter(markdown);
    const fields = parsed?.fields ?? {};
    const model = textField(fields['model']);
    const tools = listField(fields['tools']);
    return {
      name,
      description: textField(fields['description']) ?? '',
      body: (parsed?.body ?? markdown).replace(/^\n/, ''),
      ...(kind === 'agents' && model !== undefined ? { model } : {}),
      ...(kind === 'agents' && tools !== undefined ? { tools } : {}),
      markdown,
    };
  }

  put(
    kind: CapabilityKind,
    name: string,
    input: OwnerCapabilityInput,
  ): Promise<{ created: boolean }> {
    return this.serial(async () => {
      const file = this.fileOf(kind, name);
      const current = await readOrNull(file);
      if (current !== null) await this.backUp(kind, name, file);
      await this.ensureManifest();
      const agent = kind === 'agents' ? (input as OwnerAgentInput) : undefined;
      await this.replace(
        file,
        serializeFrontmatter({
          name,
          description: input.description,
          body: input.body,
          tools: agent?.tools,
          model: agent?.model,
        }),
      );
      return { created: current === null };
    });
  }

  delete(kind: CapabilityKind, name: string): Promise<boolean> {
    return this.serial(async () => {
      const file = this.fileOf(kind, name);
      if ((await readOrNull(file)) === null) return false;
      await this.backUp(kind, name, file);
      await rm(file, { force: true });
      // A skill folder may hold files the owner added by hand: remove it only when empty.
      if (kind === 'skills') await rmdir(dirname(file)).catch(() => undefined);
      return true;
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    // A failed write must not poison the queue for the next one.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The directory only counts as a plugin once `plugin.json` exists (run-args looks for it). */
  private async ensureManifest(): Promise<void> {
    const manifest = join(this.options.pluginDir, '.claude-plugin', 'plugin.json');
    if ((await readOrNull(manifest)) !== null) return;
    await this.replace(
      manifest,
      `${JSON.stringify(
        {
          name: OWNER_PLUGIN_NAME,
          description: 'Skills and subagents the owner wrote in the Jarvis UI.',
        },
        null,
        2,
      )}\n`,
    );
  }

  private async replace(file: string, content: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${this.sequence++}.tmp`;
    try {
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** `<stamp>-<counter>.<kind>.<name>.md`: sorts by time, so pruning drops the oldest. */
  private async backUp(kind: CapabilityKind, name: string, file: string): Promise<void> {
    const { backupsDir, backupsKept = DEFAULT_BACKUPS_KEPT } = this.options;
    await mkdir(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const suffix = String(this.sequence++).padStart(6, '0');
    await copyFile(file, join(backupsDir, `${stamp}-${suffix}.${kind}.${name}.md`));

    const kept = Math.max(1, typeof backupsKept === 'function' ? backupsKept() : backupsKept);
    const copies = (await readdir(backupsDir)).filter((entry) => entry.endsWith('.md')).sort();
    for (const stale of copies.slice(0, Math.max(0, copies.length - kept))) {
      await rm(join(backupsDir, stale), { force: true });
    }
  }
}
