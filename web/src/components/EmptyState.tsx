import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  title: string;
  description?: string;
  /** The next step: a link or button. */
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.icon} aria-hidden="true">
        <Icon name="inbox" size="lg" />
      </span>
      <h2 className={styles.title}>{title}</h2>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action}
    </div>
  );
}
