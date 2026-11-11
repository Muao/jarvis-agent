import { TASK_MODELS, type TaskModel, type ThreadDetailDto } from '@jarvis/shared';
import { useCanMutate, useConfig, useSetTaskModel } from '../../api/queries';
import { isTerminalStage } from './threadFilters';
import styles from './ThreadView.module.css';

const capitalize = (text: string): string => `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;

/**
 * The thread task's model, switchable from the header, and a mark when the task is on hold. A new
 * model applies from the task's next worker run; once the task is over the selector only shows
 * what it ran on.
 */
export function TaskControls({ thread }: { thread: ThreadDetailDto }) {
  const canMutate = useCanMutate();
  const setModel = useSetTaskModel();
  const config = useConfig();
  const { taskId } = thread;
  if (taskId === null) return null;
  const over = isTerminalStage(thread.stage);
  // A task with no model of its own runs on the configured default; name it rather than leave a blank.
  const fallback = config.data?.valid ? config.data.config.models.worker : null;

  return (
    <>
      {thread.held && !over ? (
        <span className={styles.held} title="No worker run starts until you resume the task">
          ⏸ On hold
        </span>
      ) : null}
      <select
        className={styles.model}
        aria-label="Model"
        title={
          over
            ? "The model the task's worker ran on"
            : "The model the task's worker runs on, from its next run"
        }
        value={thread.model ?? ''}
        disabled={over || !canMutate || setModel.isPending}
        onChange={(event) => setModel.mutate({ taskId, model: event.target.value as TaskModel })}
      >
        {thread.model === null ? (
          <option value="">
            {fallback ? `${capitalize(fallback)} (default)` : 'Default model'}
          </option>
        ) : null}
        {TASK_MODELS.map((model) => (
          <option key={model} value={model}>
            {capitalize(model)}
          </option>
        ))}
      </select>
    </>
  );
}
