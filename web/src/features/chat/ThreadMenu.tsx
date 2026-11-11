import { useState } from 'react';
import { Link } from 'react-router';
import type { ThreadDetailDto } from '@jarvis/shared';
import {
  useArchiveThread,
  useCancelTask,
  useCanMutate,
  useHoldTask,
  useResumeTask,
} from '../../api/queries';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { isTerminalStage } from './threadFilters';
import styles from './ThreadView.module.css';

interface ThreadMenuProps {
  thread: ThreadDetailDto;
  /** Shows the task status locally, or asks the dispatcher when the thread has no task. */
  onStatus: () => void;
}

/** The `⋯` actions of a thread. */
export function ThreadMenu({ thread, onStatus }: ThreadMenuProps) {
  const canMutate = useCanMutate();
  const cancel = useCancelTask();
  const hold = useHoldTask();
  const resume = useResumeTask();
  const archive = useArchiveThread();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { taskId } = thread;
  const canCancel = taskId !== null && !isTerminalStage(thread.stage) && canMutate;

  return (
    <div className={styles.menuWrap}>
      <button
        type="button"
        className={styles.menuButton}
        aria-label="Thread actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open ? (
        <div role="menu" aria-label="Thread actions" className={styles.menu}>
          <button
            type="button"
            role="menuitem"
            disabled={taskId === null && !canMutate}
            onClick={() => {
              setOpen(false);
              onStatus();
            }}
          >
            Status
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canCancel}
            onClick={() => {
              setOpen(false);
              if (taskId === null) return;
              (thread.held ? resume : hold).mutate(taskId);
            }}
          >
            {thread.held ? 'Resume task' : 'Hold task'}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canCancel}
            onClick={() => {
              setOpen(false);
              setConfirming(true);
            }}
          >
            Cancel task
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canMutate}
            onClick={() => {
              setOpen(false);
              archive.mutate({ threadId: thread.id, archived: !thread.archived });
            }}
          >
            {thread.archived ? 'Unarchive thread' : 'Archive thread'}
          </button>
          {taskId ? (
            <Link role="menuitem" to={`/tasks/${encodeURIComponent(taskId)}`}>
              Open task
            </Link>
          ) : (
            <span role="menuitem" aria-disabled="true">
              Open task
            </span>
          )}
          {thread.dispatcherSessionId ? (
            <Link
              role="menuitem"
              to={`/sessions/${encodeURIComponent(thread.dispatcherSessionId)}`}
            >
              Open dispatcher session
            </Link>
          ) : (
            <span role="menuitem" aria-disabled="true">
              Open dispatcher session
            </span>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={`Cancel task ${taskId ?? ''}?`}
        description="The worker stops. The branch and any open PR stay as they are."
        confirmLabel="Cancel task"
        cancelLabel="Keep running"
        destructive
        onConfirm={() => {
          setConfirming(false);
          if (taskId) cancel.mutate(taskId);
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
