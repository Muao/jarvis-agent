import { Link, useNavigate } from 'react-router';
import type { RunDto, RunStatus } from '@jarvis/shared';
import { RelativeTime } from '../../components/RelativeTime';
import { describeTokens, elapsedMs, formatDuration, formatTokens, formatUsd } from './format';
import table from './Table.module.css';

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  limit_reached: 'limit reached',
  interrupted: 'interrupted',
};

const consoleHref = (run: RunDto) =>
  `/sessions/${encodeURIComponent(run.sessionId)}?run=${encodeURIComponent(run.id)}`;

export function RunsTable({ runs, now }: { runs: RunDto[]; now: Date }) {
  const navigate = useNavigate();
  if (runs.length === 0) return <p className={table.muted}>No runs yet.</p>;
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Stage</th>
            <th scope="col">Started</th>
            <th scope="col">Duration</th>
            <th scope="col">Status</th>
            <th scope="col">Tokens</th>
            <th scope="col" className={table.numeric}>
              Notional $
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.id}
              className={table.clickable}
              onClick={(event) => {
                if (!(event.target instanceof Element) || !event.target.closest('a')) {
                  void navigate(consoleHref(run));
                }
              }}
            >
              <td>
                <Link to={consoleHref(run)}>{run.role}</Link>
              </td>
              <td>{run.stage ?? '—'}</td>
              <td>
                <RelativeTime at={run.startedAt} />
              </td>
              <td className={table.numeric}>
                {formatDuration(elapsedMs(run.startedAt, run.endedAt, now))}
              </td>
              <td>
                {STATUS_LABEL[run.status]}
                {run.status === 'limit_reached' ? (
                  <span className={table.muted}>
                    {' '}
                    ({run.turns}/{run.maxTurns} turns)
                  </span>
                ) : null}
              </td>
              <td title={describeTokens(run.usage)}>{formatTokens(run.usage)}</td>
              <td className={table.numeric}>{formatUsd(run.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
