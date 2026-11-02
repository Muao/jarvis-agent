import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { JarvisConfigSchema, formatConfigError, type JarvisConfig } from '@jarvis/shared';
import type { ConfigProvider } from '../../application/ports/config-provider.js';
import { StartupError } from './startup-error.js';

export interface FileConfigProviderOptions {
  /** Debounce for file-system events; editors emit several per save. */
  debounceMs?: number;
  now?: () => string;
}

type Parsed = { ok: true; config: JarvisConfig } | { ok: false; message: string };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function parseFile(path: string): Parsed {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'file not found' : String(error);
    return {
      ok: false,
      message: `${path}: ${reason}. Copy jarvis.config.example.json to ${path} and set repo.path.`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: `${path}: invalid JSON (${(error as Error).message})` };
  }
  const result = JarvisConfigSchema.safeParse(json);
  if (!result.success) return { ok: false, message: formatConfigError(result.error) };
  return { ok: true, config: deepFreeze(result.data) };
}

/**
 * Config from `jarvis.config.json` (ADR-0006). `current()` is a frozen snapshot: a run captures it at start
 * and keeps it (LIM-05). A valid edit replaces it; an invalid edit keeps the last good one and records the error.
 */
export class FileConfigProvider implements ConfigProvider {
  private config: JarvisConfig | undefined;
  private error: string | null = null;
  private loaded: string | null = null;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(config: JarvisConfig) => void>();
  private readonly debounceMs: number;
  private readonly now: () => string;

  constructor(
    private readonly path: string,
    options: FileConfigProviderOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 150;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Reads and validates the file; throws StartupError listing `path: message` lines (LIM-02). Then starts watching. */
  load(): JarvisConfig {
    const parsed = parseFile(this.path);
    if (!parsed.ok) throw new StartupError(`Invalid config ${this.path}:\n${parsed.message}`);
    this.config = parsed.config;
    this.error = null;
    this.loaded = this.now();
    this.startWatching();
    return parsed.config;
  }

  current(): JarvisConfig {
    if (!this.config) throw new Error('FileConfigProvider.load() must be called before current()');
    return this.config;
  }

  /** Message of the last rejected edit, or null when the file on disk is the one in use. */
  lastError(): string | null {
    return this.error;
  }

  /** When the config in use was loaded (ISO), or null before load(). */
  loadedAt(): string | null {
    return this.loaded;
  }

  onChange(listener: (config: JarvisConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.listeners.clear();
  }

  private startWatching(): void {
    if (this.watcher) return;
    const file = basename(this.path);
    // Watch the directory: editors replace the file (rename), which drops a file-level watch.
    this.watcher = watch(dirname(this.path), (_event, name) => {
      if (name === null || name === file) this.schedule();
    });
    this.watcher.on('error', () => undefined);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reload(), this.debounceMs);
  }

  private reload(): void {
    const parsed = parseFile(this.path);
    if (!parsed.ok) {
      this.error = parsed.message;
      return;
    }
    this.error = null;
    this.config = parsed.config;
    this.loaded = this.now();
    for (const listener of this.listeners) listener(parsed.config);
  }
}
