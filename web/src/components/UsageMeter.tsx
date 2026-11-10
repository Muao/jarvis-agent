import { useState } from 'react';
import { Link } from 'react-router';
import type { UsageDto } from '@jarvis/shared';
import { useCanMutate, useResetUsage } from '../api/queries';
import { ConfirmDialog } from './ConfirmDialog';
import { RelativeTime } from './RelativeTime';
import styles from './UsageMeter.module.css';

const WARNING_RATIO = 0.8;

type UsageLevel = 'ok' | 'warning' | 'paused';

export function usageLevel(usage: UsageDto): UsageLevel {
  if (usage.paused || usage.todayUsd >= usage.budgetUsd) return 'paused';
  return usage.todayUsd / usage.budgetUsd >= WARNING_RATIO ? 'warning' : 'ok';
}

const usd = (value: number) => `$${value.toFixed(2)}`;

interface UsageMeterProps {
  usage: UsageDto;
  /** `compact` is the shell link to `/config`; `full` adds the reset time and state text. */
  variant?: 'compact' | 'full';
}

/** Starts "spent today" over from now (LIM-04); asks first because it cannot be undone. */
function ResetUsageButton() {
  const [asking, setAsking] = useState(false);
  const reset = useResetUsage();
  const canMutate = useCanMutate();
  return (
    <>
      <button
        type="button"
        className={styles.reset}
        disabled={!canMutate || reset.isPending}
        onClick={() => setAsking(true)}
      >
        Reset
      </button>
      <ConfirmDialog
        open={asking}
        title="Reset today's usage?"
        description="Spent today starts again from $0.00 and queued work starts at once. Midnight still resets it as before."
        confirmLabel="Reset usage"
        onConfirm={() => {
          setAsking(false);
          reset.mutate();
        }}
        onCancel={() => setAsking(false)}
      />
    </>
  );
}

export function UsageMeter({ usage, variant = 'compact' }: UsageMeterProps) {
  const level = usageLevel(usage);
  const percent = Math.min(100, Math.round((usage.todayUsd / usage.budgetUsd) * 100));
  const label = `notional ${usd(usage.todayUsd)} / ${usd(usage.budgetUsd)} today`;
  const bar = (
    <span
      role="progressbar"
      aria-label="Daily budget used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={styles.track}
    >
      <span className={`${styles.fill} ${styles[level]}`} style={{ width: `${percent}%` }} />
    </span>
  );
  const state =
    level === 'paused' ? 'Paused' : level === 'warning' ? `Near limit (${percent}%)` : null;

  if (variant === 'compact') {
    return (
      <div className={styles.row}>
        <Link to="/config" className={`${styles.meter} ${styles.compact}`}>
          <span>{label}</span>
          {state ? <strong className={styles[level]}>{state}</strong> : null}
          {bar}
        </Link>
        <ResetUsageButton />
      </div>
    );
  }
  return (
    <div className={styles.meter}>
      <p className={styles.headline}>{label}</p>
      {bar}
      <p className={styles.detail}>
        {state ? <strong className={styles[level]}>{state}. </strong> : null}
        Resets <RelativeTime at={usage.resetsAt} />
      </p>
    </div>
  );
}
