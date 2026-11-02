import { Link, useParams, useSearchParams } from 'react-router';
import type { RunDto, SessionDto, SessionStatus } from '@jarvis/shared';
import { useRunEvents, useSession } from '../../api/queries';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { RelativeTime } from '../../components/RelativeTime';
import { ControlPanel } from './ControlPanel';
import { formatDuration } from './EventRow';
import { EventStream } from './EventStream';
import styles from './SessionPage.module.css';

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: '● Running',
  idle: '○ Idle',
  waiting_for_permission: '⏸ Waiting for permission',
  stopped: '■ Stopped',
  error: '✕ Error',
};

const usd = (value: number) => `notional $${value.toFixed(2)}`;
const num = (value: number) => value.toLocaleString('en');

export function SessionPage() {
  const { sessionId } = useParams();
  const session = useSession(sessionId);
  if (session.isPending) return <Loading label="Loading session…" />;
  if (session.isError) {
    return (
      <ErrorBlock
        error={session.error}
        title="Could not load the session"
        onRetry={() => void session.refetch()}
      />
    );
  }
  return <SessionView session={session.data} />;
}

function pickRun(runs: RunDto[], wanted: string | null): RunDto | undefined {
  return (
    runs.find((run) => run.id === wanted) ??
    runs.find((run) => run.status === 'running') ??
    runs.at(-1)
  );
}

function SessionView({ session }: { session: SessionDto }) {
  const [params, setParams] = useSearchParams();
  const run = pickRun(session.runs, params.get('run'));
  const events = useRunEvents(run?.id);
  const active = run?.status === 'running';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Session · {session.role}</h1>
        <dl className={styles.facts}>
          <div>
            <dt>Status</dt>
            <dd>{STATUS_LABEL[session.status]}</dd>
          </div>
          <div>
            <dt>{session.taskId ? 'Task' : 'Thread'}</dt>
            <dd>
              {session.taskId ? (
                <Link to={`/tasks/${session.taskId}`}>{session.taskId} →</Link>
              ) : (
                <Link to={`/chat/${session.threadId}`}>Open thread →</Link>
              )}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{session.model}</dd>
          </div>
          <div>
            <dt>CLI session</dt>
            <dd className={styles.mono}>{session.claudeSessionId ?? '—'}</dd>
          </div>
          <div>
            <dt>Runs</dt>
            <dd>{session.runs.length}</dd>
          </div>
        </dl>
      </header>

      {session.status === 'stopped' ? (
        <p role="status" className={styles.notice}>
          ■ This session was stopped.
        </p>
      ) : null}

      {run === undefined ? (
        <EmptyState
          title="No runs yet"
          description="Events appear here as soon as this session starts a run."
        />
      ) : (
        <>
          <RunNotices run={run} session={session} />
          <div className={styles.runBar}>
            <label className={styles.runLabel}>
              Run
              <select
                value={run.id}
                onChange={(event) => setParams({ run: event.target.value }, { replace: true })}
              >
                {session.runs.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    Run {index + 1} · {item.status}
                    {item.stage ? ` · ${item.stage}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <RunSummary run={run} />
          {events.isPending ? (
            <Loading label="Loading events…" />
          ) : events.isError ? (
            <ErrorBlock
              error={events.error}
              title="Could not load events"
              onRetry={() => void events.refetch()}
            />
          ) : (
            <EventStream events={events.data} runId={run.id} live={active} />
          )}
        </>
      )}
      <ControlPanel session={session} activeRunId={active && run ? run.id : null} />
    </div>
  );
}

function RunNotices({ run, session }: { run: RunDto; session: SessionDto }) {
  const failedStatuses = ['failed', 'limit_reached', 'interrupted'];
  return (
    <>
      {failedStatuses.includes(run.status) ? (
        <div role="alert" className={styles.failure}>
          <strong>
            {run.status === 'limit_reached'
              ? `✕ Run stopped at max turns (${run.maxTurns})`
              : run.status === 'interrupted'
                ? '✕ Run was interrupted'
                : '✕ Run failed'}
          </strong>
          {run.error ? <p>{run.error}</p> : null}
          {run.exitCode !== null ? <p>Exit code {run.exitCode}</p> : null}
        </div>
      ) : null}
      {run.status === 'running' && session.stalled ? (
        <p role="status" className={styles.warning}>
          ⚠ No events for a while: the process may be stalled.
        </p>
      ) : null}
    </>
  );
}

function RunSummary({ run }: { run: RunDto }) {
  const ended = run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null;
  return (
    <section aria-label="Run summary" className={styles.summary}>
      <dl className={styles.facts}>
        <div>
          <dt>Input tokens</dt>
          <dd>{num(run.usage.input)}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd>{num(run.usage.output)}</dd>
        </div>
        <div>
          <dt>Cache read</dt>
          <dd>{num(run.usage.cacheRead)}</dd>
        </div>
        <div>
          <dt>Cache write</dt>
          <dd>{num(run.usage.cacheWrite)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{usd(run.costUsd)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {ended !== null && Number.isFinite(ended) ? (
              formatDuration(Math.max(0, ended))
            ) : (
              <>
                running since <RelativeTime at={run.startedAt} />
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd>
            {run.turns} / {run.maxTurns}
          </dd>
        </div>
      </dl>
    </section>
  );
}
