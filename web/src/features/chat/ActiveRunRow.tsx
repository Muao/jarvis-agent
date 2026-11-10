import { useEffect, useState } from 'react';
import type { ActiveRunDto } from '@jarvis/shared';
import styles from './ActiveRunRow.module.css';

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/** Shown at the bottom of a thread while a run is working in it: who, for how long, and what it is on. */
export function ActiveRunRow({ run }: { run: ActiveRunDto }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const who = run.taskId === null ? 'dispatcher' : `worker of ${run.taskId}`;
  return (
    <div role="status" aria-label="Jarvis is working" className={styles.row}>
      <span className={styles.dot} aria-hidden="true" />
      <div className={styles.text}>
        <p className={styles.head}>
          Jarvis is working…{' '}
          <span className={styles.meta}>
            {who} · {elapsed(now - Date.parse(run.startedAt))}
          </span>
        </p>
        {run.note ? <p className={styles.line}>{run.note}</p> : null}
        {run.tool ? <p className={styles.line}>Now: {run.tool}</p> : null}
      </div>
    </div>
  );
}
