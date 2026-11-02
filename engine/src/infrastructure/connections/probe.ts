import type { ConnectionOutcome } from '../../application/ports/connection-checks.js';

/** Looks at one connection and says how it stands. May reject; the caller turns that into `failed`. */
export type Probe = () => Promise<ConnectionOutcome>;

export const reasonOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 200) || 'unknown error';
};

export const detail = (label: string, value: string): { label: string; value: string } => ({
  label,
  value,
});
