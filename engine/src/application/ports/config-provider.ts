import type { JarvisConfig } from '@jarvis/shared';

export interface ConfigProvider {
  /** The current validated config; a use case reads it once per call. */
  current(): JarvisConfig;
  /**
   * ADR-0020: merges `patch` into the on-disk config and validates the whole result against
   * `JarvisConfigSchema` before writing; throws (no write) when the merged result does not
   * parse. The caller is responsible for rejecting patches to fields that stay owner-edited
   * only before calling this.
   */
  update(patch: Record<string, unknown>): Promise<JarvisConfig>;
}

/** Where the config comes from and whether the file on disk is the one in use (Config screen). */
export interface ConfigStatus {
  /** Absolute path of the config file. */
  path(): string;
  /** When the config in use was loaded, or null before the first load. */
  loadedAt(): string | null;
  /** The `path: message` lines of the last rejected edit, or null when the file on disk is in use. */
  lastError(): string | null;
}
