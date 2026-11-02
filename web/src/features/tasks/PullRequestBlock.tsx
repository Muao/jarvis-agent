import type { ReviewState, TaskDetailDto } from '@jarvis/shared';
import { Markdown } from '../../components/Markdown';
import { RelativeTime } from '../../components/RelativeTime';
import { CheckRow } from './CheckRow';
import { shortSha } from './format';
import type { Check, ReviewComment } from './types';
import styles from './PullRequestBlock.module.css';

const REVIEW_LABEL: Record<ReviewState, string> = {
  pending: 'Pending',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};

const HANDLING_LABEL: Record<ReviewComment['handling'], string> = {
  pending: 'pending',
  handled: 'handled',
  ignored: 'ignored',
};

export function PullRequestBlock({ task }: { task: TaskDetailDto }) {
  const { pullRequest, counters } = task;
  if (pullRequest === null) return <p className={styles.empty}>No pull request yet.</p>;
  return (
    <div className={styles.body}>
      <p className={styles.summary}>
        <a href={pullRequest.url} target="_blank" rel="noreferrer">
          PR #{pullRequest.number}
        </a>
        <span>
          Head <code>{shortSha(pullRequest.headSha)}</code>
        </span>
        <span>Review: {REVIEW_LABEL[pullRequest.review]}</span>
        {pullRequest.lastCheckedAt !== null ? (
          <span className={styles.muted}>
            Checked <RelativeTime at={pullRequest.lastCheckedAt} />
          </span>
        ) : null}
      </p>
      <p className={styles.counters}>
        <span>
          Check retries {counters.checks.used}/{counters.checks.max}
        </span>
        <span>
          CI fixes {counters.ciFixes.used}/{counters.ciFixes.max}
        </span>
        <span>
          Review rounds {counters.reviews.used}/{counters.reviews.max}
        </span>
      </p>

      <h3 className={styles.subtitle}>Checks</h3>
      <Checks checks={pullRequest.checks} />
      {pullRequest.earlierChecks.length > 0 ? (
        <details className={styles.earlier}>
          <summary>Earlier commits ({pullRequest.earlierChecks.length})</summary>
          <Checks checks={pullRequest.earlierChecks} />
        </details>
      ) : null}

      <h3 className={styles.subtitle}>Review comments</h3>
      {pullRequest.comments.length === 0 ? (
        <p className={styles.empty}>No comments.</p>
      ) : (
        <ul className={styles.comments}>
          {pullRequest.comments.map((comment) => (
            <li key={comment.id} className={styles.comment}>
              <p className={styles.author}>
                <strong>{comment.author}</strong>
                <span className={styles.mark}>{HANDLING_LABEL[comment.handling]}</span>
              </p>
              <Markdown>{comment.body}</Markdown>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Checks({ checks }: { checks: Check[] }) {
  if (checks.length === 0) return <p className={styles.empty}>No checks reported yet.</p>;
  return (
    <ul className={styles.checks}>
      {checks.map((check) => (
        <CheckRow key={check.name} check={check} />
      ))}
    </ul>
  );
}
