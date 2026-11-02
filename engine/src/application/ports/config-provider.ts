import type { JarvisConfig } from '@jarvis/shared';

export interface ConfigProvider {
  /** The current validated config; a use case reads it once per call. */
  current(): JarvisConfig;
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
