import { Link } from 'react-router';
import { StageBadge } from '../../../components/StageBadge';
import { elapsedMs, formatDuration } from '../../tasks/format';
import styles from './Card.module.css';
import type { CardProps } from './types';

const SYMBOL = { done: '✓', active: '…', pending: '○' } as const;

/** One card per task; the engine updates the same message, so the list key (message id) keeps it in place. */
export function StatusCard({ message }: Pick<CardProps<'status'>, 'message'>) {
  const { taskId, stage, workerSessionId, startedAt, steps, checks, ciFixes, reviews } =
    message.body;
  const closed = stage === 'Done' || stage === 'Failed' || stage === 'Cancelled';
  return (
    <article
      className={styles.card}
      aria-label={`Status of ${taskId}`}
      data-status-card={taskId}
      tabIndex={-1}
    >
      <h3 className={styles.heading}>
        {taskId} <StageBadge stage={stage} />
      </h3>
      <ul className={styles.list} aria-label="Steps">
        {steps.map((step) => (
          <li key={step.label}>
            <span aria-hidden="true">{SYMBOL[step.state]} </span>
            {step.label}
            <span className={styles.mark}> ({step.state})</span>
          </li>
        ))}
      </ul>
      <div className={styles.counters}>
        <span>
          checks {checks.used}/{checks.max}
        </span>
        <span>
          CI fixes {ciFixes.used}/{ciFixes.max}
        </span>
        <span>
          reviews {reviews.used}/{reviews.max}
        </span>
        {startedAt !== null && !closed ? (
          <span>elapsed {formatDuration(elapsedMs(startedAt, null, new Date()))}</span>
        ) : null}
      </div>
      <div className={styles.actions}>
        <Link className={styles.link} to={`/tasks/${encodeURIComponent(taskId)}`}>
          Open task →
        </Link>
        {workerSessionId !== null ? (
          <Link className={styles.link} to={`/sessions/${encodeURIComponent(workerSessionId)}`}>
            Open console →
          </Link>
        ) : null}
      </div>
    </article>
  );
}
