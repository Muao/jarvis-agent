import { Link } from 'react-router';
import type { ThreadDto } from '@jarvis/shared';
import styles from './WaitingCounter.module.css';

/** The thread that has waited the longest, or undefined when nothing waits. */
export function oldestWaiting(threads: readonly ThreadDto[]): ThreadDto | undefined {
  return threads
    .filter((thread) => thread.waitingForOwner)
    .sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt))[0];
}

export function WaitingCounter({ threads }: { threads: readonly ThreadDto[] }) {
  const count = threads.filter((thread) => thread.waitingForOwner).length;
  const oldest = oldestWaiting(threads);
  if (!oldest) return <span className={styles.idle}>Waiting for you: 0</span>;
  return (
    <Link to={`/chat/${encodeURIComponent(oldest.id)}`} className={styles.waiting}>
      Waiting for you: {count}
    </Link>
  );
}
