import { useState } from 'react';
import { Link } from 'react-router';
import type { OverviewDto } from '@jarvis/shared';
import { NetworkError, useOverview } from '../../api/queries';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { RelativeTime } from '../../components/RelativeTime';
import { StageBadge } from '../../components/StageBadge';
import { StageStepper } from '../../components/StageStepper';
import { formatTokenCount } from '../tasks/format';
import { formatDuration, useNow } from './useNow';
import styles from './Overview.module.css';

type Slot = OverviewDto['workers'][number];
type OverviewEvent = OverviewDto['events'][number];

const usd = (value: number) => `$${value.toFixed(2)}`;

const DISPATCHER_LABEL: Record<OverviewDto['dispatcher']['status'], string> = {
  idle: 'Idle',
  running: 'Running',
  waiting_for_permission: 'Waiting for permission',
  error: 'Error',
};

const QUEUE_LABEL: Record<OverviewDto['queue'][number]['what'], string> = {
  new_task: 'New task',
  ci_event: 'CI event',
  owner_reply: 'Owner reply',
};

const EVENT_TYPES = ['stage', 'ci', 'review', 'permission', 'error'] as const;

function isBusy(slot: Slot): boolean {
  return (
    slot.state === 'busy' || slot.state === 'stalled' || slot.state === 'waiting_for_permission'
  );
}

function Kpis({ data }: { data: OverviewDto }) {
  const busy = data.workers.filter(isBusy).length;
  const items = [
    ['Workers busy', `${busy}/${data.workers.length}`],
    ['Queue', String(data.queue.length)],
    ['Waiting for you', String(data.waitingForOwner)],
    ['PRs open', String(data.prsOpen)],
    [
      'Usage today',
      `${formatTokenCount(data.usage.todayTokens)} / ${formatTokenCount(data.usage.budgetTokens)} tokens`,
    ],
  ] as const;
  return (
    <ul className={styles.kpis} aria-label="Key figures">
      {items.map(([label, value]) => (
        <li key={label} className={styles.kpi}>
          <span className={styles.kpiLabel}>{label}</span>
          <span className={styles.kpiValue}>{value}</span>
        </li>
      ))}
    </ul>
  );
}

function DispatcherCard({
  dispatcher,
  now,
}: {
  dispatcher: OverviewDto['dispatcher'];
  now: number;
}) {
  return (
    <section className={styles.section} aria-labelledby="ov-dispatcher">
      <h2 id="ov-dispatcher" className={styles.sectionTitle}>
        Dispatcher
      </h2>
      <div className={styles.card}>
        <div className={styles.row}>
          <strong>{DISPATCHER_LABEL[dispatcher.status]}</strong>
          {dispatcher.runningSince ? (
            <span className={styles.muted}>
              running {formatDuration(now - new Date(dispatcher.runningSince).getTime())}
            </span>
          ) : null}
        </div>
        <p className={styles.muted}>{dispatcher.action ?? 'No current action'}</p>
        {dispatcher.sessionId ? (
          <Link to={`/sessions/${encodeURIComponent(dispatcher.sessionId)}`}>Console →</Link>
        ) : null}
      </div>
    </section>
  );
}

function WorkerCard({
  slot,
  index,
  budgetPaused,
  now,
}: {
  slot: Slot;
  index: number;
  budgetPaused: boolean;
  now: number;
}) {
  const heading = `Worker ${index + 1}`;
  if (slot.state === 'free') {
    return (
      <article className={styles.card} aria-label={heading}>
        <h3 className={styles.cardTitle}>{heading}</h3>
        <p>{budgetPaused ? 'Paused' : 'Free'}</p>
        {budgetPaused ? <p className={styles.muted}>Daily budget reached.</p> : null}
      </article>
    );
  }
  const paused = slot.state === 'paused' || budgetPaused;
  return (
    <article className={styles.card} aria-label={heading}>
      <h3 className={styles.cardTitle}>{heading}</h3>
      <div className={styles.row}>
        <Link to={`/tasks/${encodeURIComponent(slot.taskId)}`}>
          <span className={styles.mono}>{slot.taskId}</span> {slot.title}
        </Link>
        <StageBadge stage={slot.stage} />
        {paused ? <span className={styles.marker}>Paused</span> : null}
        {slot.state === 'stalled' ? (
          <span className={styles.marker}>⚠ Stalled — no events for a while</span>
        ) : null}
        {slot.state === 'waiting_for_permission' ? (
          <span className={styles.marker}>⏸ Waiting for permission</span>
        ) : null}
      </div>
      <StageStepper stage={slot.stage} />
      <p className={styles.muted}>{slot.action ?? 'Thinking'}</p>
      <p className={styles.muted}>
        {formatDuration(now - new Date(slot.startedAt).getTime())} · notional {usd(slot.runCostUsd)}
      </p>
      <Link to={`/sessions/${encodeURIComponent(slot.sessionId)}`}>Console →</Link>
    </article>
  );
}

function QueueTable({ queue }: { queue: OverviewDto['queue'] }) {
  return (
    <section className={styles.section} aria-labelledby="ov-queue">
      <h2 id="ov-queue" className={styles.sectionTitle}>
        Queue
      </h2>
      {queue.length === 0 ? (
        <p className={styles.muted}>Nothing is waiting for a free worker.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Task</th>
              <th scope="col">What</th>
              <th scope="col">Since</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((item) => (
              <tr key={`${item.taskId}-${item.what}-${item.since}`}>
                <td>{item.position}</td>
                <td>
                  <Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>
                </td>
                <td>{QUEUE_LABEL[item.what]}</td>
                <td>
                  <RelativeTime at={item.since} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function WatchingTable({ watching, now }: { watching: OverviewDto['watching']; now: number }) {
  return (
    <section className={styles.section} aria-labelledby="ov-watching">
      <h2 id="ov-watching" className={styles.sectionTitle}>
        Watching
      </h2>
      {watching.length === 0 ? (
        <p className={styles.muted}>No open PRs are being watched.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Stage</th>
              <th scope="col">PR</th>
              <th scope="col">CI</th>
              <th scope="col">Review</th>
              <th scope="col">Last check</th>
              <th scope="col">Next check</th>
            </tr>
          </thead>
          <tbody>
            {watching.map((item) => (
              <tr key={item.taskId}>
                <td>
                  <Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>
                </td>
                <td>
                  <StageBadge stage={item.stage} />
                </td>
                <td>
                  {item.prUrl ? (
                    <a href={item.prUrl} target="_blank" rel="noreferrer">
                      PR
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{item.ci ?? '—'}</td>
                <td>{item.review ? item.review.replace('_', ' ') : '—'}</td>
                <td>{item.lastCheckedAt ? <RelativeTime at={item.lastCheckedAt} /> : '—'}</td>
                <td>
                  {item.nextCheckAt
                    ? `next check in ${Math.max(0, Math.ceil((new Date(item.nextCheckAt).getTime() - now) / 1000))} s`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function EventLog({ events }: { events: OverviewEvent[] }) {
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<OverviewEvent[]>([]);
  const [taskFilter, setTaskFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const source = paused ? frozen : events;
  const taskIds = [
    ...new Set(events.map((e) => e.taskId).filter((id): id is string => id !== null)),
  ];
  const shown = source
    .filter((e) => (taskFilter ? e.taskId === taskFilter : true))
    .filter((e) => (typeFilter ? e.type === typeFilter : true))
    .toSorted((a, b) => b.at.localeCompare(a.at));
  const missed = paused ? events.length - frozen.length : 0;

  const toggle = () => {
    if (!paused) setFrozen(events);
    setPaused(!paused);
  };

  return (
    <section className={styles.section} aria-labelledby="ov-events">
      <h2 id="ov-events" className={styles.sectionTitle}>
        Event log
      </h2>
      <div className={styles.filters}>
        <label>
          Task{' '}
          <select value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)}>
            <option value="">All tasks</option>
            {taskIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type{' '}
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={styles.button} onClick={toggle}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        {paused ? (
          <span className={styles.muted} role="status">
            Log paused{missed > 0 ? ` — ${missed} new` : ''}
          </span>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className={styles.muted}>No events match.</p>
      ) : (
        <ul className={styles.log}>
          {shown.map((event) => (
            <li key={event.id}>
              <RelativeTime at={event.at} />
              <span className={styles.mono}>{event.type}</span>
              {event.taskId ? <span className={styles.mono}>{event.taskId}</span> : null}
              <span>{event.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OverviewPage() {
  const { data, error, isPending, refetch } = useOverview();
  const now = useNow(1000);

  if (isPending) return <Loading label="Loading overview…" />;
  if (error) {
    return error instanceof NetworkError ? (
      <EmptyState
        title="Engine offline"
        description="Jarvis cannot reach the engine. Start it and this page reconnects."
        action={
          <button type="button" className={styles.button} onClick={() => void refetch()}>
            Retry
          </button>
        }
      />
    ) : (
      <ErrorBlock
        error={error}
        title="Could not load the overview"
        onRetry={() => void refetch()}
      />
    );
  }

  const budgetPaused = data.usage.paused;
  const idle =
    !budgetPaused &&
    data.workers.every((slot) => slot.state === 'free') &&
    data.queue.length === 0 &&
    data.dispatcher.status === 'idle';

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Overview</h1>
      <Kpis data={data} />
      {budgetPaused ? (
        <p role="status" className={styles.marker}>
          Paused — daily budget reached. Queue does not move until{' '}
          <RelativeTime at={data.usage.resetsAt} />.
        </p>
      ) : null}
      {idle ? <p role="status">Jarvis is idle</p> : null}
      <DispatcherCard dispatcher={data.dispatcher} now={now} />
      <section className={styles.section} aria-labelledby="ov-workers">
        <h2 id="ov-workers" className={styles.sectionTitle}>
          Workers
        </h2>
        <div className={styles.cards}>
          {data.workers.map((slot, index) => (
            <WorkerCard
              key={index}
              slot={slot}
              index={index}
              budgetPaused={budgetPaused}
              now={now}
            />
          ))}
        </div>
      </section>
      <QueueTable queue={data.queue} />
      <WatchingTable watching={data.watching} now={now} />
      <EventLog events={data.events} />
    </div>
  );
}
