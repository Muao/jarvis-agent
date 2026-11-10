import { TASK_MODELS, type TaskModel, type ThreadDetailDto } from '@jarvis/shared';
import { useCanMutate, useSetTaskModel } from '../../api/queries';
import { isTerminalStage } from './threadFilters';
import styles from './ThreadView.module.css';

/**
 * The thread task's model, switchable from the header, and a mark when the task is on hold. A new
 * model applies from the task's next worker run.
 */
export function TaskControls({ thread }: { thread: ThreadDetailDto }) {
  const canMutate = useCanMutate();
  const setModel = useSetTaskModel();
  const { taskId } = thread;
  if (taskId === null || isTerminalStage(thread.stage)) return null;

  return (
    <>
      {thread.held ? (
        <span className={styles.held} title="No worker run starts until you resume the task">
          ⏸ On hold
        </span>
      ) : null}
      <select
        className={styles.model}
        aria-label="Model"
        title="The model the task's worker runs on, from its next run"
        value={thread.model ?? ''}
        disabled={!canMutate || setModel.isPending}
        onChange={(event) => setModel.mutate({ taskId, model: event.target.value as TaskModel })}
      >
        {thread.model === null ? <option value="">Default model</option> : null}
        {TASK_MODELS.map((model) => (
          <option key={model} value={model}>
            {model[0]?.toUpperCase()}
            {model.slice(1)}
          </option>
        ))}
      </select>
    </>
  );
}
