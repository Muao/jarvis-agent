import { CheckStatus } from './CheckStatus';
import { formatDuration } from './format';
import type { Check } from './types';
import styles from './CheckRow.module.css';

export function CheckRow({ check }: { check: Check }) {
  return (
    <li className={styles.row}>
      <span className={styles.name}>{check.name}</span>
      <CheckStatus status={check.status} />
      <span className={styles.duration}>
        {check.durationMs !== null ? formatDuration(check.durationMs) : '—'}
      </span>
      {check.url !== null ? (
        <a href={check.url} target="_blank" rel="noreferrer" aria-label={`Log for ${check.name}`}>
          Log
        </a>
      ) : (
        <span aria-hidden="true" />
      )}
    </li>
  );
}
