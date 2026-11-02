import { memo, useState } from 'react';
import { Collapsible } from '../../components/Collapsible';
import { Markdown } from '../../components/Markdown';
import { toolDurationMs, type TimelineItem } from './timeline';
import styles from './EventRow.module.css';

/** Rendered-text caps: the full text stays in the cache, the DOM never gets more than this. */
export const MAX_TEXT_CHARS = 20_000;
export const MAX_OUTPUT_CHARS = 50_000;
const MAX_INPUT_CHARS = 10_000;

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

function capped(text: string, max: number): { shown: string; hidden: number } {
  return text.length > max
    ? { shown: text.slice(0, max), hidden: text.length - max }
    : { shown: text, hidden: 0 };
}

function Truncated({ hidden }: { hidden: number }) {
  return hidden > 0 ? (
    <p className={styles.note}>… {hidden.toLocaleString('en')} more characters not shown</p>
  ) : null;
}

const time = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString();
};

interface EventRowProps {
  item: TimelineItem;
  current?: boolean;
  nested?: boolean;
}

function EventRowView({ item, current = false, nested = false }: EventRowProps) {
  return (
    <li
      id={`ev-${item.base.key}`}
      className={`${styles.row} ${nested ? styles.nested : ''} ${current ? styles.current : ''}`}
      aria-current={current ? 'true' : undefined}
    >
      <Body item={item} />
    </li>
  );
}

/** Memoised on the item signature: a live append re-renders only the rows that changed. */
export const EventRow = memo(
  EventRowView,
  (prev, next) =>
    prev.item.base.sig === next.item.base.sig &&
    prev.current === next.current &&
    prev.nested === next.nested,
);

function Body({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case 'text': {
      const { shown, hidden } = capped(item.text, MAX_TEXT_CHARS);
      return (
        <div className={styles.text}>
          <Markdown>{shown}</Markdown>
          <Truncated hidden={hidden} />
          <time className={styles.time}>{time(item.base.at)}</time>
        </div>
      );
    }
    case 'tool':
      return <ToolCall item={item} />;
    case 'permission':
      return (
        <p className={styles.line}>
          <span className={styles.label}>Permission</span> {item.toolName}:{' '}
          <strong>{decisionText(item.decision)}</strong>
        </p>
      );
    case 'system':
      return (
        <p className={`${styles.line} ${styles.muted}`}>
          <span className={styles.label}>System</span> {item.subtype}
          {item.message ? ` — ${item.message}` : ''}
        </p>
      );
    case 'result':
      return (
        <p className={`${styles.line} ${item.isError ? styles.errorText : styles.muted}`}>
          <span className={styles.label}>
            {item.isError ? '✕ Run ended with error' : 'Turn finished'}
          </span>{' '}
          {item.subtype} · {item.turns} turns · {formatDuration(item.durationMs)}
          {item.text ? ` — ${capped(item.text, 2000).shown}` : ''}
        </p>
      );
    case 'error':
      return (
        <p role="alert" className={`${styles.line} ${styles.errorText}`}>
          <span className={styles.label}>✕ Error</span> {capped(item.message, MAX_TEXT_CHARS).shown}
        </p>
      );
  }
}

function decisionText(decision: 'pending' | 'allow' | 'deny' | 'timeout'): string {
  switch (decision) {
    case 'pending':
      return '… waiting for decision';
    case 'allow':
      return '✓ allowed';
    case 'deny':
      return '✕ denied';
    case 'timeout':
      return '✕ timed out';
  }
}

function ToolCall({ item }: { item: Extract<TimelineItem, { type: 'tool' }> }) {
  const [inputOpen, setInputOpen] = useState(false);
  const duration = toolDurationMs(item);
  const failed = item.result?.payload.isError === true;
  const output = item.result ? capped(item.result.payload.content, MAX_OUTPUT_CHARS) : null;
  const input =
    inputOpen && item.input ? capped(JSON.stringify(item.input, null, 2), MAX_INPUT_CHARS) : null;
  return (
    <div className={styles.tool}>
      <p className={styles.line}>
        <span className={styles.label}>Tool</span> <strong>{item.name}</strong>
        {item.subagent ? <span className={styles.subagent}>subagent: {item.subagent}</span> : null}
        <span className={failed ? styles.errorText : styles.ok}>
          {item.result ? (failed ? '✕ error' : '✓ ok') : '… running'}
        </span>
        {duration !== null ? (
          <span className={styles.muted}>{formatDuration(duration)}</span>
        ) : null}
      </p>
      {item.input ? (
        <details onToggle={(event) => setInputOpen(event.currentTarget.open)}>
          <summary>Input</summary>
          {input ? (
            <>
              <pre className={styles.pre}>{input.shown}</pre>
              <Truncated hidden={input.hidden} />
            </>
          ) : null}
        </details>
      ) : null}
      {output ? (
        <div className={styles.output}>
          <Collapsible text={output.shown} maxLines={6} />
          <Truncated hidden={output.hidden} />
        </div>
      ) : null}
      {item.children.length > 0 ? (
        <ul
          className={styles.children}
          aria-label={`Events of subagent ${item.subagent ?? item.name}`}
        >
          {item.children.map((child) => (
            <EventRow key={child.base.key} item={child} nested />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
