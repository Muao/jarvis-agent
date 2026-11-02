import type { TaskStage } from '@jarvis/shared';
import styles from './StageStepper.module.css';

const STEPS = ['Context', 'Spec', 'Impl', 'Verify', 'Review', 'PR'] as const;

/** Index into `STEPS` that a stage belongs to; -1 before the first step. */
function stepIndex(stage: TaskStage): number {
  switch (stage) {
    case 'Intake':
      return -1;
    case 'Context':
      return 0;
    case 'Spec Review':
      return 1;
    case 'Implementing':
    case 'Fixing':
      return 2;
    case 'Verifying':
      return 3;
    case 'Reviewing':
      return 4;
    case 'PR Open':
    case 'Done':
      return 5;
    case 'Blocked':
    case 'Failed':
    case 'Cancelled':
      return -1;
  }
}

interface StageStepperProps {
  stage: TaskStage;
  /** Where a Blocked, Failed or Cancelled task stopped, when known. */
  stoppedAt?: TaskStage;
  /** How many times the current step ran again (fix rounds, review rounds). */
  repeats?: number;
}

type StepState = 'done' | 'current' | 'pending' | 'stopped';

function stepState(index: number, current: number, stage: TaskStage, stopped: boolean): StepState {
  if (stage === 'Done') return 'done';
  if (index < current) return 'done';
  if (index === current) return stopped ? 'stopped' : 'current';
  return 'pending';
}

export function StageStepper({ stage, stoppedAt, repeats = 0 }: StageStepperProps) {
  const halted = stage === 'Blocked' || stage === 'Failed' || stage === 'Cancelled';
  const current = stepIndex(halted ? (stoppedAt ?? stage) : stage);
  return (
    <ol className={styles.stepper} aria-label="Task progress">
      {STEPS.map((label, index) => {
        const state = stepState(index, current, stage, halted);
        return (
          <li
            key={label}
            className={`${styles.step} ${styles[state]}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span aria-hidden="true" className={styles.mark}>
              {state === 'done' ? '✓' : state === 'stopped' ? '✕' : state === 'current' ? '●' : '○'}
            </span>
            {label}
            {state === 'current' && repeats > 0 ? (
              <span className={styles.repeats}>×{repeats + 1}</span>
            ) : null}
            <span className="visually-hidden"> ({state})</span>
          </li>
        );
      })}
    </ol>
  );
}
