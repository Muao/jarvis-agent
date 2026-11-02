import { RelativeTime } from '../../components/RelativeTime';
import type { JournalEntry } from './types';
import styles from './JournalList.module.css';

export function JournalList({ entries }: { entries: JournalEntry[] }) {
  if (entries.length === 0) return <p className={styles.empty}>The journal is empty.</p>;
  const chronological = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <ol className={styles.journal} aria-label="Task journal">
      {chronological.map((entry) => (
        <li key={entry.id} className={styles.entry}>
          <RelativeTime at={entry.at} />
          <span className={styles.type}>{entry.type}</span>
          <span className={styles.text}>{entry.text}</span>
          {entry.by === 'owner' ? <span className={styles.owner}>by owner</span> : null}
        </li>
      ))}
    </ol>
  );
}
