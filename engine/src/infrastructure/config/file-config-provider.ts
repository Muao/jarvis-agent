import { readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `patch` wins; nested objects merge key-by-key instead of replacing the whole object (ADR-0020). */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

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

  /**
   * ADR-0020: merges `patch` into the raw on-disk config (not the in-memory defaulted one),
   * validates the whole result, and writes only if it parses. The file watcher picks up this
   * write like any other edit; `this.config` is updated here too so the caller gets the fresh
   * value immediately instead of waiting for the debounced reload.
   */
  async update(patch: Record<string, unknown>): Promise<JarvisConfig> {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      throw new Error(`${this.path}: ${(error as Error).message}`, { cause: error });
    }
    let current: unknown;
    try {
      current = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${this.path}: invalid JSON (${(error as Error).message})`, { cause: error });
    }
    if (!isPlainObject(current)) throw new Error(`${this.path}: expected a JSON object`);
    const merged = deepMerge(current, patch);
    const result = JarvisConfigSchema.safeParse(merged);
    if (!result.success) throw new Error(formatConfigError(result.error));
    writeFileSync(this.path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    const config = deepFreeze(result.data);
    this.config = config;
    this.error = null;
    this.loaded = this.now();
    return config;
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
