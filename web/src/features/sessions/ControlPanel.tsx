import { useState, type FormEvent } from 'react';
import { RETRYABLE_STAGES, type SessionDto } from '@jarvis/shared';
import {
  useCanMutate,
  useOverview,
  useRetryTask,
  useSendSessionMessage,
  useStopRun,
  useTask,
} from '../../api/queries';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import styles from './ControlPanel.module.css';

interface Sent {
  id: number;
  text: string;
  delivery: 'queued' | 'delivered';
}

interface ControlPanelProps {
  session: SessionDto;
  /** The selected run, when it is still going and so can be stopped. */
  activeRunId: string | null;
}

/** ADM-06: message the session, stop the current process, restart the stage. */
export function ControlPanel({ session, activeRunId }: ControlPanelProps) {
  const canMutate = useCanMutate();
  const overview = useOverview();
  const budgetPaused = overview.data?.usage.paused === true;
  const send = useSendSessionMessage(session.id);
  const stop = useStopRun();
  const retry = useRetryTask();
  const task = useTask(session.taskId ?? undefined);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<Sent[]>([]);
  const [confirmStop, setConfirmStop] = useState(false);
  const taskId = session.taskId;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (body === '') return;
    send.mutate(
      { text: body },
      {
        onSuccess: (result) => {
          setSent((list) => [...list, { id: list.length, text: body, delivery: result.delivery }]);
          setText('');
        },
      },
    );
  };

  const sendDisabled = !canMutate || budgetPaused || send.isPending || text.trim() === '';
  const stopDisabled = !canMutate || activeRunId === null || stop.isPending;
  // Same rule as the engine's RetryStage: Failed or a stage with a worker.
  const retryableStage = task.data !== undefined && RETRYABLE_STAGES.includes(task.data.stage);
  const retryDisabled =
    !canMutate || budgetPaused || taskId === null || !retryableStage || retry.isPending;

  const explanations: string[] = [];
  if (!canMutate) explanations.push('Engine offline: controls are disabled until it is back.');
  if (budgetPaused)
    explanations.push('Paused: daily budget reached. Send message and Retry stage are disabled.');
  if (taskId === null) explanations.push('This session has no task: Retry stage is not available.');
  else if (task.data !== undefined && !retryableStage)
    explanations.push(`Retry stage is not available in ${task.data.stage}.`);

  return (
    <section className={styles.panel} aria-label="Controls">
      <form className={styles.form} onSubmit={onSubmit}>
        <label className={styles.label}>
          Message to the session
          <textarea
            className={styles.input}
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button type="submit" className={styles.primary} disabled={sendDisabled}>
          Send message
        </button>
      </form>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.danger}
          disabled={stopDisabled}
          onClick={() => setConfirmStop(true)}
        >
          Stop run
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={retryDisabled}
          onClick={() => taskId !== null && retry.mutate(taskId)}
        >
          Retry stage
        </button>
      </div>
      {explanations.length > 0 ? (
        <ul className={styles.explain}>
          {explanations.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {send.isError ? (
        <p role="alert" className={styles.error}>
          Could not send the message: {send.error.message}
        </p>
      ) : null}
      {stop.isError || retry.isError ? (
        <p role="alert" className={styles.error}>
          The action failed. Try again.
        </p>
      ) : null}
      {sent.length > 0 ? (
        <ul className={styles.sent} aria-label="Sent messages">
          {sent.map((message) => (
            <li key={message.id}>
              {message.text}{' '}
              <span className={styles.mark}>
                {message.delivery === 'queued' ? '… queued' : '✓ delivered'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <ConfirmDialog
        open={confirmStop}
        title="Stop this run?"
        description="The CLI process is stopped. The session can be resumed later."
        confirmLabel="Stop run"
        destructive
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          if (activeRunId !== null) stop.mutate(activeRunId);
        }}
      />
    </section>
  );
}
