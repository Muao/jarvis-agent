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
  const settings = config.data?.valid ? config.data : undefined;
  const codex = Boolean(settings?.config.engine.codexBinary);
  const choices = codex
    ? (settings?.codexModels ?? [])
    : TASK_MODELS.map((id) => ({ id, label: capitalize(id) }));
  const selected = thread.model && thread.model.startsWith('codex:') === codex ? thread.model : '';
  const fallback = codex
    ? (settings?.codexModels?.find(({ isDefault }) => isDefault)?.label ?? 'Codex')
    : settings?.config.models.worker;

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
        value={selected}
        disabled={over || !canMutate || setModel.isPending || !settings || choices.length === 0}
        onChange={(event) => setModel.mutate({ taskId, model: event.target.value as TaskModel })}
      >
        {!choices.some(({ id }) => id === selected) ? (
          <option value={selected} disabled>
            {selected
              ? selected.replace(/^codex:/, '')
              : fallback
                ? `${capitalize(fallback)} (default)`
                : 'Default model'}
          </option>
        ) : null}
        {choices.map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </>
  );
}
