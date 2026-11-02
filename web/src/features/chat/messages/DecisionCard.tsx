import { useState } from 'react';
import { Link } from 'react-router';
import { useAnswerMessage, useCanMutate } from '../../../api/queries';
import { Markdown } from '../../../components/Markdown';
import { formatClock } from '../threadFilters';
import styles from './Card.module.css';
import type { CardProps } from './types';
import { useOnce } from './useOnce';

export function DecisionCard({ message, cancelled }: CardProps<'decision'>) {
  const canMutate = useCanMutate();
  const once = useOnce(useAnswerMessage());
  const [changing, setChanging] = useState(false);
  const [comment, setComment] = useState('');
  const { answer, answeredAt } = message;
  const answered = answer !== null && 'decision' in answer;
  const inactive = answered || once.sent || cancelled;
  const disabled = inactive || !canMutate;
  const taskPath = `/tasks/${encodeURIComponent(message.body.taskId)}`;

  const send = (body: { decision: 'approve' } | { decision: 'request_changes'; comment: string }) =>
    once.submit({ messageId: message.id, body });

  let outcome: string | null = null;
  if (answered && answer) {
    const label = answer.decision === 'approve' ? 'Approved' : 'Changes requested';
    outcome = `${label}${answeredAt ? ` · ${formatClock(answeredAt)}` : ''}`;
  } else if (once.sent) {
    outcome = 'Answer sent…';
  } else if (cancelled) {
    outcome = 'Task cancelled';
  }

  return (
    <article
      className={`${styles.card} ${inactive ? styles.inactive : ''}`}
      aria-label={`Decision for ${message.body.taskId}`}
    >
      <h3 className={styles.heading}>Decision needed · {message.body.taskId}</h3>
      <Markdown>{message.body.summary}</Markdown>
      {message.body.artifacts.length > 0 ? (
        <ul className={styles.list} aria-label="Artifacts">
          {message.body.artifacts.map((name) => (
            <li key={name}>
              <Link className={styles.link} to={`${taskPath}?artifact=${encodeURIComponent(name)}`}>
                {name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {outcome ? <p className={styles.outcome}>{outcome}</p> : null}
      {answered && answer && 'comment' in answer && answer.comment ? (
        <p className={styles.text}>{answer.comment}</p>
      ) : null}
      {!inactive && changing ? (
        <div className={styles.actions}>
          <textarea
            className={styles.field}
            aria-label="What should change"
            rows={3}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            disabled={disabled || comment.trim() === ''}
            onClick={() => send({ decision: 'request_changes', comment: comment.trim() })}
          >
            Send changes
          </button>
        </div>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={disabled}
          onClick={() => send({ decision: 'approve' })}
        >
          Approve
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={disabled}
          aria-expanded={changing}
          onClick={() => setChanging((open) => !open)}
        >
          Request changes
        </button>
        <Link className={styles.link} to={taskPath}>
          Open task →
        </Link>
      </div>
      {once.error ? <p className={styles.error}>Could not send: {once.error.message}</p> : null}
    </article>
  );
}
