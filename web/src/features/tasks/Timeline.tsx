import { RelativeTime } from '../../components/RelativeTime';
import { StageBadge } from '../../components/StageBadge';
import { elapsedMs, formatDuration } from './format';
import type { StageSpan } from './types';
import styles from './Timeline.module.css';

/** Which time this span ran for: open spans run until `now`. */
function spanDuration(span: StageSpan, now: Date): string {
  return formatDuration(elapsedMs(span.enteredAt, span.exitedAt, now));
}

export function Timeline({ stages, now }: { stages: StageSpan[]; now: Date }) {
  if (stages.length === 0) return <p className={styles.empty}>No stages yet.</p>;
  const seen = new Map<string, number>();
  return (
    <ol className={styles.timeline} aria-label="Stage timeline">
      {stages.map((span) => {
        const visit = (seen.get(span.stage) ?? 0) + 1;
        seen.set(span.stage, visit);
        return (
          <li key={`${span.stage}-${span.enteredAt}`} className={styles.span}>
            <StageBadge stage={span.stage} />
            {visit > 1 ? <span className={styles.repeat}>again (×{visit})</span> : null}
            <span className={styles.times}>
              <RelativeTime at={span.enteredAt} />
              {' → '}
              {span.exitedAt === null ? 'now' : <RelativeTime at={span.exitedAt} />} ·{' '}
              {spanDuration(span, now)}
            </span>
            {span.reason !== null ? (
              <span className={styles.reason}>Reason: {span.reason}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
