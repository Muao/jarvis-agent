import { useState } from 'react';
import styles from './Collapsible.module.css';

interface CollapsibleProps {
  text: string;
  /** Lines shown before `Show more`. */
  maxLines?: number;
}

/** Long output (tool results, inputs) shows its first lines; only the visible part is rendered. */
export function Collapsible({ text, maxLines = 8 }: CollapsibleProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > maxLines;
  const shown = expanded || !long ? text : lines.slice(0, maxLines).join('\n');
  return (
    <div className={styles.collapsible}>
      <pre className={styles.text}>{shown}</pre>
      {long ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : `Show more (${lines.length - maxLines} more lines)`}
        </button>
      ) : null}
    </div>
  );
}
