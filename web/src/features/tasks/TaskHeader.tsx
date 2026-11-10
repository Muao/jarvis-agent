import { useState } from 'react';
import { Link } from 'react-router';
import { RETRYABLE_STAGES, type TaskDetailDto } from '@jarvis/shared';
import {
  useCanMutate,
  useCancelTask,
  useOverview,
  useRetryTask,
  useStopTask,
} from '../../api/queries';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorBlock } from '../../components/ErrorBlock';
import { RelativeTime } from '../../components/RelativeTime';
import { StageBadge } from '../../components/StageBadge';
import { usageLevel } from '../../components/UsageMeter';
import { elapsedMs, formatDuration, formatUsd } from './format';
import styles from './TaskHeader.module.css';

type Pending = 'stop' | 'cancel' | null;

interface TaskHeaderProps {
  task: TaskDetailDto;
  now: Date;
}

const isClosed = (stage: TaskDetailDto['stage']) =>
  stage === 'Done' || stage === 'Failed' || stage === 'Cancelled';

export function TaskHeader({ task, now }: TaskHeaderProps) {
  const canMutate = useCanMutate();
  const { data: overview } = useOverview();
  const retry = useRetryTask();
  const stop = useStopTask();
  const cancel = useCancelTask();
  const [pending, setPending] = useState<Pending>(null);

  const paused = overview !== undefined && usageLevel(overview.usage) === 'paused';
  const hasRunningRun = task.runs.some((run) => run.status === 'running');
  // Same rule as the engine's RetryStage: Failed or a stage with a worker.
  const retryable = RETRYABLE_STAGES.includes(task.stage);
  const error = retry.error ?? stop.error ?? cancel.error;

  const hint = !canMutate
    ? 'Actions are disabled until the engine is back.'
    : task.stage === 'Cancelled'
      ? 'Task cancelled — actions are disabled.'
      : paused && retryable
        ? 'Retry stage is disabled: the daily budget is used up.'
        : null;

  const elapsed = formatDuration(
    elapsedMs(task.startedAt, isClosed(task.stage) ? task.updatedAt : null, now),
  );

  const confirm = () => {
    if (pending === 'stop') stop.mutate(task.id);
    if (pending === 'cancel') cancel.mutate(task.id);
    setPending(null);
  };

  return (
    <header className={styles.header}>
      <p className={styles.id}>{task.id}</p>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{task.title}</h1>
        <StageBadge stage={task.stage} working={task.working} />
      </div>

      <dl className={styles.facts}>
        <div>
          <dt>Waiting for</dt>
          <dd>{task.waitingFor}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>
            <code>{task.branch}</code>
          </dd>
        </div>
        <div>
          <dt>PR</dt>
          <dd>
            {task.prUrl !== null && task.prNumber !== null ? (
              <a href={task.prUrl} target="_blank" rel="noreferrer">
                #{task.prNumber}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>Thread</dt>
          <dd>
            <Link to={`/chat/${encodeURIComponent(task.threadId)}`}>Open thread</Link>
          </dd>
        </div>
        {task.workerSessionId !== null ? (
          <div>
            <dt>Session</dt>
            <dd>
              <Link to={`/sessions/${encodeURIComponent(task.workerSessionId)}`}>
                Open worker session
              </Link>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Elapsed</dt>
          <dd>{elapsed}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>notional {formatUsd(task.costUsd)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <RelativeTime at={task.updatedAt} />
          </dd>
        </div>
      </dl>

      {task.stage === 'Failed' || task.stage === 'Blocked' ? (
        <div role="note" className={styles.reason}>
          <strong>{task.stage === 'Failed' ? 'Failed' : 'Blocked'}</strong>
          {task.reason !== null ? <span>: {task.reason}</span> : null}
          <FailedAttempts runs={task.runs} />
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          disabled={!canMutate || !retryable || paused || retry.isPending}
          aria-describedby={hint !== null ? 'task-actions-hint' : undefined}
          onClick={() => retry.mutate(task.id)}
        >
          Retry stage
        </button>
        <button
          type="button"
          disabled={!canMutate || !hasRunningRun || stop.isPending}
          aria-describedby={hint !== null ? 'task-actions-hint' : undefined}
          onClick={() => setPending('stop')}
        >
          Stop worker
        </button>
        <button
          type="button"
          className={styles.danger}
          disabled={!canMutate || isClosed(task.stage) || cancel.isPending}
          aria-describedby={hint !== null ? 'task-actions-hint' : undefined}
          onClick={() => setPending('cancel')}
        >
          Cancel task
        </button>
      </div>
      {hint !== null ? (
        <p id="task-actions-hint" className={styles.hint}>
          {hint}
          {paused && retryable ? (
            <> Resets {overview ? <RelativeTime at={overview.usage.resetsAt} /> : null}.</>
          ) : null}
        </p>
      ) : null}
      {error ? <ErrorBlock error={error} title="The action failed" /> : null}

      <ConfirmDialog
        open={pending === 'cancel'}
        destructive
        title={`Cancel ${task.id}?`}
        description="The worker stops. The branch and the PR stay as they are."
        confirmLabel="Cancel task"
        cancelLabel="Keep running"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'stop'}
        destructive
        title={`Stop the worker of ${task.id}?`}
        description="The current run ends; you can retry the stage afterwards."
        confirmLabel="Stop worker"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </header>
  );
}

/** The last failed runs, so the owner sees what was tried before pressing Retry. */
function FailedAttempts({ runs }: { runs: TaskDetailDto['runs'] }) {
  const failed = runs.filter((run) => run.status === 'failed' || run.error !== null).slice(-3);
  if (failed.length === 0) return null;
  return (
    <ul className={styles.attempts} aria-label="Last attempts">
      {failed.map((run) => (
        <li key={run.id}>
          {run.stage ?? 'run'} · {run.status.replace('_', ' ')}
          {run.error !== null ? `: ${run.error}` : ''}
        </li>
      ))}
    </ul>
  );
}
