import { useState } from 'react';
import { Link } from 'react-router';
import {
  USAGE_GROUPS,
  USAGE_MAX_WINDOW_DAYS,
  type UsageGroupBy,
  type UsageQuery,
  type UsageReport,
  type UsageRow,
  type UsageTotal,
} from '@jarvis/shared';
import { useConfig, useUsageReport } from '../../api/queries';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { StageBadge } from '../../components/StageBadge';
import { formatDuration, formatTokens, formatUsd } from '../tasks/format';
import table from '../tasks/Table.module.css';
import styles from './Usage.module.css';

const DAY_MS = 86_400_000;

const GROUP_LABEL: Record<UsageGroupBy, string> = {
  day: 'By day',
  session: 'By session',
  task: 'By task',
  model: 'By model',
};

const KEY_HEADER: Record<UsageGroupBy, string> = {
  day: 'Day (UTC)',
  session: 'Session',
  task: 'Task',
  model: 'Model',
};

type Span =
  | { kind: 'days'; days: 7 | 30; from: string | undefined }
  | { kind: 'custom'; from: string; to: string };

/** `from` for a "last N days" preset, fixed when chosen so the query key stays stable. */
const presetWindow = (days: 7 | 30): Span => ({
  kind: 'days',
  days,
  // 7 days is the engine default; leaving `from` out lets the engine decide.
  from: days === 7 ? undefined : new Date(Date.now() - days * DAY_MS).toISOString(),
});

/** Custom window: UTC dates, both days included. Returns an error text or the API window. */
function customWindow(
  fromDate: string,
  toDate: string,
): { error: string } | { from: string; to: string } {
  if (!fromDate || !toDate) return { error: 'Pick both a start and an end date.' };
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`) + DAY_MS; // `to` is exclusive
  if (Number.isNaN(from) || Number.isNaN(to)) return { error: 'Pick valid dates.' };
  if (from >= to) return { error: 'The start date must not be after the end date.' };
  if (to - from > USAGE_MAX_WINDOW_DAYS * DAY_MS) {
    return { error: `The window may not be wider than ${USAGE_MAX_WINDOW_DAYS} days.` };
  }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** "12.4 / 20 USD": at most two decimals, no trailing zeros. */
const plain = (value: number) => String(Number(value.toFixed(2)));

function BudgetLine() {
  const { data, error, isPending } = useConfig();
  let body: string;
  if (isPending) body = 'Loading daily budget…';
  else if (error || !data) body = 'Daily budget unavailable.';
  else if (!data.valid) body = 'Daily budget unavailable: the config is invalid.';
  else body = `${plain(data.usage.todayUsd)} / ${plain(data.usage.budgetUsd)} USD`;
  return (
    <section className={styles.budget} aria-label="Daily budget">
      <h2 className={styles.sectionTitle}>Daily budget (notional)</h2>
      <p className={styles.budgetValue}>{body}</p>
      <p className={styles.muted}>
        Counted from local midnight and reset then. Day rows below use UTC dates, so “today” there
        can be a different window.
      </p>
    </section>
  );
}

const STOP_HINT: Record<string, string> = {
  running: 'Not finished yet',
};

function StopReasons({ reasons }: { reasons: Record<string, number> }) {
  const entries = Object.entries(reasons).filter(([, count]) => count > 0);
  if (entries.length === 0) return <span className={table.muted}>—</span>;
  return (
    <ul className={styles.badges}>
      {entries.map(([reason, count]) => (
        <li key={reason} className={styles.badge} title={STOP_HINT[reason]}>
          {reason.replaceAll('_', ' ')}
          {reason === 'running' ? ' (not finished)' : ''} ×{count}
        </li>
      ))}
    </ul>
  );
}

function KeyCell({ row, groupBy }: { row: UsageRow; groupBy: UsageGroupBy }) {
  if (groupBy === 'session') {
    return (
      <>
        <Link to={`/sessions/${encodeURIComponent(row.key)}`} className={table.mono}>
          {row.key}
        </Link>
        {row.role ? <span className={table.muted}> · {row.role}</span> : null}
        {row.taskId ? (
          <>
            {' '}
            <Link to={`/tasks/${encodeURIComponent(row.taskId)}`} className={table.mono}>
              {row.taskId}
            </Link>
          </>
        ) : null}
      </>
    );
  }
  if (groupBy === 'task') {
    return (
      <Link to={`/tasks/${encodeURIComponent(row.key)}`} className={table.mono}>
        {row.key}
      </Link>
    );
  }
  return <span className={table.mono}>{row.key}</span>;
}

function Total({ total }: { total: UsageTotal }) {
  const items = [
    ['Runs', String(total.runs)],
    ['Notional $', formatUsd(total.costUsd)],
    ['Turns', String(total.turns)],
    ['Tokens', formatTokens(total.tokens)],
    ['Finished-run time', formatDuration(total.durationMs)],
  ] as const;
  return (
    <section aria-label="Total" className={styles.total}>
      <h2 className={styles.sectionTitle}>Total in the window</h2>
      <ul className={styles.figures}>
        {items.map(([label, value]) => (
          <li key={label} className={styles.figure}>
            <span className={styles.muted}>{label}</span>
            <strong>{value}</strong>
          </li>
        ))}
      </ul>
      <StopReasons reasons={total.stopReasons} />
    </section>
  );
}

function Notes({ groupBy }: { groupBy: UsageGroupBy }) {
  return (
    <ul className={styles.notes} aria-label="Notes">
      <li>Duration counts finished runs only; a running run adds cost but no time.</li>
      {groupBy === 'model' ? (
        <li>
          Turns and duration cannot be split per model, so they show “—”. Runs without per-model
          figures appear only in the total, so these rows can add up to less than the total.
        </li>
      ) : null}
      {groupBy === 'task' ? (
        <li>Runs with no task (the dispatcher chat) appear only in the total.</li>
      ) : null}
    </ul>
  );
}

function ReportTable({ report }: { report: UsageReport }) {
  const { groupBy, rows } = report;
  const isModel = groupBy === 'model';
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">{KEY_HEADER[groupBy]}</th>
            {groupBy === 'task' ? (
              <>
                <th scope="col">Stage</th>
                <th scope="col" title="Derived: closed once Done, Failed or Cancelled">
                  Status
                </th>
              </>
            ) : null}
            <th scope="col" className={table.numeric}>
              Runs
            </th>
            <th scope="col" className={table.numeric}>
              Turns
            </th>
            <th scope="col" className={table.numeric} title="Finished runs only">
              Duration
            </th>
            <th scope="col">Tokens</th>
            <th scope="col" className={table.numeric}>
              Notional $
            </th>
            <th scope="col">Stop reasons</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={styles.rowHeader}>
                <KeyCell row={row} groupBy={groupBy} />
              </th>
              {groupBy === 'task' ? (
                <>
                  <td>{row.stage ? <StageBadge stage={row.stage} /> : '—'}</td>
                  <td>{row.status ?? '—'}</td>
                </>
              ) : null}
              <td className={table.numeric}>{row.runs}</td>
              <td className={table.numeric}>{isModel ? '—' : row.turns}</td>
              <td className={table.numeric}>{isModel ? '—' : formatDuration(row.durationMs)}</td>
              <td>{formatTokens(row.tokens)}</td>
              <td className={table.numeric}>{formatUsd(row.costUsd)}</td>
              <td>
                <StopReasons reasons={row.stopReasons} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Report({ query }: { query: UsageQuery }) {
  const { data, error, isPending, refetch } = useUsageReport(query);
  if (isPending) return <Loading label="Loading usage…" />;
  if (error) {
    return <ErrorBlock error={error} title="Could not load usage" onRetry={() => void refetch()} />;
  }
  if (data.total.runs === 0) {
    return (
      <EmptyState
        title="No runs in this window"
        description="Nothing has run yet, or nothing started in the selected dates."
      />
    );
  }
  return (
    <>
      <Total total={data.total} />
      {data.rows.length === 0 ? (
        <p className={styles.muted}>No rows for this grouping; see the total above.</p>
      ) : (
        <ReportTable report={data} />
      )}
      <Notes groupBy={data.groupBy} />
    </>
  );
}

export function UsagePage() {
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('day');
  const [span, setSpan] = useState<Span>(() => presetWindow(7));
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const custom = customWindow(fromDate, toDate);
  let query: UsageQuery | null;
  let windowError: string | null = null;
  if (span.kind === 'days') {
    query = { groupBy, ...(span.from ? { from: span.from } : {}) };
  } else if ('error' in custom) {
    query = null;
    windowError = custom.error;
  } else {
    query = { groupBy, from: custom.from, to: custom.to };
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Usage</h1>
      <BudgetLine />
      <div className={styles.controls}>
        <div role="group" aria-label="Window" className={styles.pills}>
          {([7, 30] as const).map((days) => (
            <button
              key={days}
              type="button"
              className={styles.pill}
              aria-pressed={span.kind === 'days' && span.days === days}
              onClick={() => setSpan(presetWindow(days))}
            >
              Last {days} days
            </button>
          ))}
          <button
            type="button"
            className={styles.pill}
            aria-pressed={span.kind === 'custom'}
            onClick={() => setSpan({ kind: 'custom', from: fromDate, to: toDate })}
          >
            Custom
          </button>
        </div>
        <div role="group" aria-label="Group by" className={styles.pills}>
          {USAGE_GROUPS.map((group) => (
            <button
              key={group}
              type="button"
              className={styles.pill}
              aria-pressed={groupBy === group}
              onClick={() => setGroupBy(group)}
            >
              {GROUP_LABEL[group]}
            </button>
          ))}
        </div>
      </div>
      {span.kind === 'custom' ? (
        <div className={styles.dates}>
          <label>
            From (UTC)
            <input
              type="date"
              value={fromDate}
              max={toDate || todayUtc()}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </label>
          <label>
            To (UTC, included)
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(event) => setToDate(event.target.value)}
            />
          </label>
          <span className={styles.muted}>At most {USAGE_MAX_WINDOW_DAYS} days.</span>
        </div>
      ) : null}
      {windowError ? (
        <p role="alert" className={styles.warning}>
          {windowError}
        </p>
      ) : null}
      {query ? <Report query={query} /> : null}
    </div>
  );
}
