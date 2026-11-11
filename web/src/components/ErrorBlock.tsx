import { Icon } from './Icon';
import styles from './ErrorBlock.module.css';

interface ErrorBlockProps {
  error: unknown;
  /** What failed, e.g. "Could not load tasks". */
  title?: string;
  onRetry?: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** A per-block error: one failing block never breaks the page. */
export function ErrorBlock({ error, title = 'Something went wrong', onRetry }: ErrorBlockProps) {
  return (
    <div role="alert" className={styles.error}>
      <Icon name="error" size="lg" className={styles.icon} />
      <p className={styles.title}>{title}</p>
      <p className={styles.message}>{messageOf(error)}</p>
      {onRetry ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
