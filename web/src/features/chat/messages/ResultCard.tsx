import { Link } from 'react-router';
import { Markdown } from '../../../components/Markdown';
import styles from './Card.module.css';
import type { CardProps } from './types';

export function ResultCard({ message }: Pick<CardProps<'result'>, 'message'>) {
  const { taskId, summary, prUrl } = message.body;
  return (
    <article className={styles.card} aria-label={`Result of ${taskId}`}>
      <h3 className={styles.heading}>Result · {taskId}</h3>
      <Markdown>{summary}</Markdown>
      <div className={styles.actions}>
        {prUrl ? (
          <a className={styles.link} href={prUrl} target="_blank" rel="noreferrer">
            Open PR ↗
          </a>
        ) : null}
        <Link
          className={styles.link}
          to={`/tasks/${encodeURIComponent(taskId)}?artifact=result.md`}
        >
          Open result.md
        </Link>
      </div>
    </article>
  );
}
