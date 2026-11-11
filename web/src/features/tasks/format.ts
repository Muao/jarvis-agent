import type { TokenUsage } from '@jarvis/shared';

/** Notional cost; the caller adds the `notional` label where there is no column header saying so. */
export const formatUsd = (value: number): string => `$${value.toFixed(2)}`;

/** 45s · 2m 05s · 1h 03m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Milliseconds between two ISO strings; `end` defaults to `now`. */
export function elapsedMs(start: string, end: string | null, now: Date): number {
  return (end === null ? now.getTime() : new Date(end).getTime()) - new Date(start).getTime();
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Everything a run read and wrote: input, output, cache writes and cache reads. */
export const totalTokens = (usage: TokenUsage): number =>
  usage.input + usage.output + usage.cacheWrite + usage.cacheRead;

/**
 * "1.2M · 7.5K out": the total first, because almost all of a run's tokens are the context it
 * re-reads from the cache on every turn — input and output alone look like nothing was used.
 */
export const formatTokens = (usage: TokenUsage): string =>
  `${compact.format(totalTokens(usage))} · ${compact.format(usage.output)} out`;

/** The full split, for a tooltip. */
export const describeTokens = (usage: TokenUsage): string =>
  `${usage.input.toLocaleString('en-US')} input · ${usage.output.toLocaleString('en-US')} output · ` +
  `${usage.cacheWrite.toLocaleString('en-US')} cache write · ${usage.cacheRead.toLocaleString('en-US')} cache read`;

/** 950 · 12.4K · 3.2M — a token count short enough for a meter. */
export const formatTokenCount = (tokens: number): string => compact.format(tokens);

export const shortSha = (sha: string): string => sha.slice(0, 7);
