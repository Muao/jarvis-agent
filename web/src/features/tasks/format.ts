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

export const formatTokens = (usage: TokenUsage): string =>
  `${compact.format(usage.input)} in · ${compact.format(usage.output)} out`;

/** 950 · 12.4K · 3.2M — a token count short enough for a meter. */
export const formatTokenCount = (tokens: number): string => compact.format(tokens);

export const shortSha = (sha: string): string => sha.slice(0, 7);
