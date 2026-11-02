import type { CheckStatus as CheckStatusValue } from '@jarvis/shared';
import styles from './CheckStatus.module.css';

const SYMBOLS: Record<CheckStatusValue, string> = {
  queued: '○',
  running: '◔',
  passed: '✓',
  failed: '✕',
  skipped: '–',
};

/** Check status as a symbol plus a word, so colour is never the only cue. */
export function CheckStatus({ status }: { status: CheckStatusValue }) {
  return (
    <span className={`${styles.status} ${styles[status]}`}>
      <span aria-hidden="true">{SYMBOLS[status]}</span> {status}
    </span>
  );
}
