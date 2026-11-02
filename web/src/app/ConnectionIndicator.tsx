import { useLiveStream, type ConnectionStatus } from '../api/stream';
import styles from './ConnectionIndicator.module.css';

const LABELS: Record<ConnectionStatus, { symbol: string; text: string }> = {
  live: { symbol: '●', text: 'Live' },
  reconnecting: { symbol: '◌', text: 'Reconnecting…' },
  offline: { symbol: '○', text: 'Offline' },
};

export function ConnectionIndicator() {
  const { status } = useLiveStream();
  const { symbol, text } = LABELS[status];
  return (
    <span
      className={`${styles.indicator} ${styles[status]}`}
      role="status"
      aria-label="Engine connection"
    >
      <span aria-hidden="true">{symbol}</span> {text}
    </span>
  );
}
