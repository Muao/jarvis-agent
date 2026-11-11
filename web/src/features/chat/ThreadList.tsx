import { useState } from 'react';
import { Link } from 'react-router';
import type { ThreadDto } from '@jarvis/shared';
import { useArchiveThread, useCanMutate } from '../../api/queries';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Icon } from '../../components/Icon';
import { Loading } from '../../components/Loading';
import { RelativeTime } from '../../components/RelativeTime';
import { StageBadge } from '../../components/StageBadge';
import { FILTERS, visibleThreads, type ThreadFilter } from './threadFilters';
import styles from './ThreadList.module.css';

interface ThreadListProps {
  threads: ThreadDto[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string | undefined;
  /** Lets the column's resize handle point at the list (`aria-controls`). */
  id?: string;
}

export function ThreadList({ threads, loading, error, onRetry, selectedId, id }: ThreadListProps) {
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const rows = threads ? visibleThreads(threads, filter) : [];
  const canMutate = useCanMutate();
  const archive = useArchiveThread();

  return (
    <section id={id} className={styles.list} aria-label="Threads">
      <div className={styles.top}>
        <Link to="/chat" className={styles.newThread}>
          <Icon name="plus" size="sm" />
          New thread
        </Link>
        <div role="group" aria-label="Filter threads" className={styles.filters}>
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={styles.filter}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {loading ? <Loading label="Loading threads…" /> : null}
      {error ? <ErrorBlock error={error} title="Could not load threads" onRetry={onRetry} /> : null}
      {threads && rows.length === 0 ? (
        <p className={styles.empty}>
          {threads.length === 0
            ? 'No threads yet. Describe a task to start one.'
            : 'No threads match this filter.'}
        </p>
      ) : null}
      <ul className={styles.rows}>
        {rows.map((thread) => (
          <li key={thread.id} className={styles.item}>
            <Link
              to={`/chat/${encodeURIComponent(thread.id)}`}
              className={styles.row}
              aria-current={thread.id === selectedId ? 'page' : undefined}
            >
              <span className={styles.title}>{thread.title}</span>
              <span className={styles.meta}>
                {thread.stage ? <StageBadge stage={thread.stage} working={thread.working} /> : null}
                <span className={styles.time}>
                  <RelativeTime at={thread.lastActivityAt} />
                </span>
              </span>
              {thread.waitingForOwner ? (
                <span className={styles.waiting}>
                  <span aria-hidden="true">● </span>Waiting for you
                </span>
              ) : null}
            </Link>
            <button
              type="button"
              className={styles.archive}
              aria-label={`${thread.archived ? 'Unarchive' : 'Archive'} ${thread.title}`}
              title={thread.archived ? 'Unarchive' : 'Archive'}
              disabled={!canMutate}
              onClick={() => archive.mutate({ threadId: thread.id, archived: !thread.archived })}
            >
              <Icon name={thread.archived ? 'unarchive' : 'archive'} size="sm" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
