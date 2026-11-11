import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import styles from './ResizeHandle.module.css';

interface ResizeHandleProps {
  /** Accessible name, e.g. "Resize thread list". */
  label: string;
  /** The id of the panel this handle resizes. */
  controls: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  /** A width while the pointer drags; not yet final. */
  onPreview: (value: number) => void;
  /** The final width: end of a drag, a key press or a reset. */
  onCommit: (value: number) => void;
}

const STEP = 16;
const BIG_STEP = 64;

function releaseBody() {
  document.body.style.removeProperty('user-select');
  document.body.style.removeProperty('cursor');
}

/** A vertical splitter: drag it, use the arrow keys (Shift for bigger steps), Home/End, or double-click to reset. */
export function ResizeHandle({
  label,
  controls,
  value,
  min,
  max,
  defaultValue,
  onPreview,
  onCommit,
}: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startValue: number; last: number } | null>(null);
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));

  // Leaving the page mid-drag must not leave the whole document unselectable.
  useEffect(() => releaseBody, []);

  const endDrag = () => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    releaseBody();
    onCommit(state.last);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // preventDefault stops text selection but also the default focus, so focus explicitly: keys work after a drag.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { startX: event.clientX, startValue: value, last: value };
    // Keep the drag from selecting text across the page.
    document.body.style.setProperty('user-select', 'none');
    document.body.style.setProperty('cursor', 'col-resize');
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const next = clamp(state.startValue + event.clientX - state.startX);
    if (next === state.last) return;
    state.last = next;
    onPreview(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const next = {
      ArrowLeft: value - step,
      ArrowRight: value + step,
      Home: min,
      End: max,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onCommit(clamp(next));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} — drag, or double-click to reset`}
      className={styles.handle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onCommit(defaultValue)}
      onKeyDown={onKeyDown}
    />
  );
}
