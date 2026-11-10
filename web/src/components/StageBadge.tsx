import type { TaskStage } from '@jarvis/shared';
import styles from './StageBadge.module.css';

interface StageLook {
  /** Shape that carries the meaning next to the colour. */
  symbol: string;
  className: string | undefined;
  terminal: boolean;
}

const LOOKS: Record<TaskStage, StageLook> = {
  Intake: { symbol: '○', className: styles.intake, terminal: false },
  Context: { symbol: '◔', className: styles.context, terminal: false },
  'Spec Review': { symbol: '◑', className: styles.specReview, terminal: false },
  Implementing: { symbol: '◕', className: styles.implementing, terminal: false },
  Verifying: { symbol: '◉', className: styles.verifying, terminal: false },
  Reviewing: { symbol: '◈', className: styles.reviewing, terminal: false },
  'PR Open': { symbol: '↗', className: styles.prOpen, terminal: false },
  Fixing: { symbol: '↻', className: styles.fixing, terminal: false },
  Done: { symbol: '✓', className: styles.done, terminal: true },
  Blocked: { symbol: '‖', className: styles.blocked, terminal: false },
  Failed: { symbol: '✕', className: styles.failed, terminal: true },
  Cancelled: { symbol: '⊘', className: styles.cancelled, terminal: true },
};

/**
 * A task in `PR Open` whose worker is running is talking to the owner about the PR (a question, a
 * retro), not changing it: it shows as `Thinking`. The stage itself stays `PR Open`, so the PR is
 * still watched; a push moves it to `Fixing`.
 */
const THINKING: StageLook = { symbol: '…', className: styles.thinking, terminal: false };

export function StageBadge({ stage, working = false }: { stage: TaskStage; working?: boolean }) {
  const thinking = working && stage === 'PR Open';
  const look = thinking ? THINKING : LOOKS[stage];
  const label = thinking ? 'Thinking' : stage;
  const className = [styles.badge, look.className, look.terminal ? styles.terminal : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={className}
      data-stage={stage}
      title={thinking ? 'PR Open — Jarvis is answering you' : undefined}
    >
      <span aria-hidden="true" className={styles.symbol}>
        {look.symbol}
      </span>
      {label}
    </span>
  );
}
