import { useId, type ReactNode } from 'react';
import styles from './Block.module.css';

interface BlockProps {
  title: string;
  /** Extra content on the heading row (counters, links). */
  aside?: ReactNode;
  children: ReactNode;
}

/** A titled section of the task page. Each block renders its own loading and error states inside. */
export function Block({ title, aside, children }: BlockProps) {
  const headingId = useId();
  return (
    <section className={styles.block} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <h2 id={headingId} className={styles.title}>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
