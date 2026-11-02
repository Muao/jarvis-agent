import { useAnswerPermission, useCanMutate } from '../../../api/queries';
import { Collapsible } from '../../../components/Collapsible';
import { formatClock } from '../threadFilters';
import styles from './Card.module.css';
import type { CardProps } from './types';
import { useOnce } from './useOnce';

export function PermissionCard({ message, cancelled }: CardProps<'permission'>) {
  const canMutate = useCanMutate();
  const once = useOnce(useAnswerPermission());
  const { answer, answeredAt } = message;
  const decided = answer !== null && 'decision' in answer ? answer.decision : null;
  const inactive = decided !== null || once.sent || cancelled;
  const disabled = inactive || !canMutate;
  const { requester, toolName, description, input, permissionId } = message.body;

  const decide = (decision: 'allow' | 'deny') => once.submit({ permissionId, body: { decision } });

  let outcome: string | null = null;
  if (decided !== null) {
    const label = decided === 'allow' ? 'Allowed' : 'Denied';
    outcome = `${label}${answeredAt ? ` · ${formatClock(answeredAt)}` : ''}`;
  } else if (once.sent) {
    outcome = 'Answer sent…';
  } else if (cancelled) {
    outcome = 'Task cancelled';
  }

  return (
    <article
      className={`${styles.card} ${inactive ? styles.inactive : ''}`}
      aria-label={`Permission request for ${toolName}`}
    >
      <h3 className={styles.heading}>Permission request · {requester}</h3>
      <p className={styles.text}>
        Tool: <strong>{toolName}</strong>
      </p>
      {description ? <p className={styles.text}>{description}</p> : null}
      {Object.keys(input).length > 0 ? (
        <Collapsible text={JSON.stringify(input, null, 2)} maxLines={4} />
      ) : null}
      {outcome ? <p className={styles.outcome}>{outcome}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={disabled}
          onClick={() => decide('allow')}
        >
          Allow
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={disabled}
          onClick={() => decide('deny')}
        >
          Deny
        </button>
      </div>
      {once.error ? <p className={styles.error}>Could not send: {once.error.message}</p> : null}
    </article>
  );
}
