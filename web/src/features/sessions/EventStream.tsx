import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RunEvent } from '@jarvis/shared';
import { EmptyState } from '../../components/EmptyState';
import { EventRow } from './EventRow';
import { buildTimeline, filterTimeline, FILTERS, type EventFilter } from './timeline';
import styles from './EventStream.module.css';

/** Rows rendered at once; older rows load on demand so thousands of events stay responsive. */
const PAGE = 200;
/** Distance from the bottom (px) that still counts as "following the stream". */
const BOTTOM_SLACK = 48;

interface EventStreamProps {
  events: readonly RunEvent[];
  /** Resets filters and scroll when another run is opened. */
  runId: string;
  live: boolean;
}

export function EventStream({ events, runId, live }: EventStreamProps) {
  return <StreamBody key={runId} events={events} live={live} />;
}

function StreamBody({ events, live }: Omit<EventStreamProps, 'runId'>) {
  const [filter, setFilter] = useState<EventFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [following, setFollowing] = useState(true);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const filtered = useMemo(
    () => filterTimeline(timeline, filter, query),
    [timeline, filter, query],
  );
  const errorKeys = useMemo(
    () => filtered.filter((item) => item.base.errors > 0).map((item) => item.base.key),
    [filtered],
  );
  const visible = useMemo(
    () => filtered.slice(Math.max(0, filtered.length - limit)),
    [filtered, limit],
  );
  const hiddenCount = filtered.length - visible.length;
  const lastSig = filtered.at(-1)?.base.sig;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (following && el) el.scrollTop = el.scrollHeight;
  }, [following, filtered.length, lastSig, limit]);

  useEffect(() => {
    if (currentKey === null) return;
    const target = document.getElementById(`ev-${currentKey}`);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center' });
    }
  }, [currentKey]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK);
  };

  const jumpToLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setCurrentKey(null);
    setFollowing(true);
  };

  const goToError = (direction: 1 | -1) => {
    if (errorKeys.length === 0) return;
    const at = currentKey === null ? -1 : errorKeys.indexOf(currentKey);
    const next =
      at === -1
        ? direction === 1
          ? 0
          : errorKeys.length - 1
        : (at + direction + errorKeys.length) % errorKeys.length;
    const key = errorKeys[next];
    if (key === undefined) return;
    const position = filtered.findIndex((item) => item.base.key === key);
    setLimit((value) => Math.max(value, filtered.length - position));
    setFollowing(false);
    setCurrentKey(key);
  };

  const errorPosition = currentKey === null ? -1 : errorKeys.indexOf(currentKey);

  return (
    <section className={styles.stream} aria-label="Event stream">
      <div className={styles.toolbar}>
        <div role="group" aria-label="Filter events" className={styles.filters}>
          {FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              className={`${styles.filter} ${filter === value ? styles.active : ''}`}
              onClick={() => {
                setFilter(value);
                setCurrentKey(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Search events"
          placeholder="Search events"
          className={styles.search}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCurrentKey(null);
          }}
        />
        <div className={styles.errors} role="group" aria-label="Error navigation">
          <button
            type="button"
            className={styles.filter}
            disabled={errorKeys.length === 0}
            onClick={() => goToError(-1)}
          >
            Previous error
          </button>
          <button
            type="button"
            className={styles.filter}
            disabled={errorKeys.length === 0}
            onClick={() => goToError(1)}
          >
            Next error
          </button>
          <span className={styles.muted}>
            {errorKeys.length === 0
              ? 'No errors'
              : `${errorPosition === -1 ? '' : `${errorPosition + 1} of `}${errorKeys.length} ${errorKeys.length === 1 ? 'error' : 'errors'}`}
          </span>
        </div>
      </div>

      <div className={styles.frame}>
        <div
          ref={scroller}
          role="log"
          aria-label="Events"
          tabIndex={0}
          className={styles.scroller}
          onScroll={onScroll}
        >
          {events.length === 0 ? (
            <EmptyState
              title="No events yet"
              description={
                live ? 'Waiting for the first event of this run.' : 'This run produced no events.'
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No events match"
              description="Change the filter or the search text."
            />
          ) : (
            <>
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className={styles.earlier}
                  onClick={() => setLimit((value) => value + PAGE)}
                >
                  Show earlier events ({hiddenCount.toLocaleString('en')} hidden)
                </button>
              ) : null}
              <ul className={styles.list}>
                {visible.map((item) => (
                  <EventRow
                    key={item.base.key}
                    item={item}
                    current={item.base.key === currentKey}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
        {!following ? (
          <button type="button" className={styles.jump} onClick={jumpToLatest}>
            Jump to latest
          </button>
        ) : null}
      </div>
    </section>
  );
}
