import { useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { Icon } from '../../components/Icon';
import styles from './Composer.module.css';

interface ComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  /** May return a promise; a rejection puts the text back so nothing typed is lost. */
  onSend: (text: string) => void | Promise<unknown>;
  /** Engine unreachable: input and button are disabled and the reason is shown. */
  offline: boolean;
  /** Budget exhausted: input stays active, a note explains that new tasks queue. */
  paused: boolean;
  /** The dispatcher is handling a message. */
  thinking?: boolean;
  large?: boolean;
  placeholder?: string;
}

export function Composer({
  value,
  onValueChange,
  onSend,
  offline,
  paused,
  thinking = false,
  large = false,
  placeholder = 'Write a message…',
}: ComposerProps) {
  const submit = () => {
    const text = value.trim();
    if (offline || text === '') return;
    onValueChange('');
    const result = onSend(text);
    if (result instanceof Promise) {
      result.catch(() => onValueChange(text));
    }
  };

  const input = useRef<HTMLTextAreaElement>(null);
  const focusInput = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLParagraphElement)) {
      return;
    }
    event.preventDefault();
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className={`${styles.composer} ${large ? styles.large : ''}`}>
      {thinking ? (
        <p role="status" className={styles.thinking}>
          Jarvis is thinking…
        </p>
      ) : null}
      {offline ? (
        <p role="alert" className={styles.offline}>
          Engine offline — messages can&apos;t be sent
        </p>
      ) : null}
      {paused ? (
        <p className={styles.note}>
          Daily budget reached. You can keep writing; new tasks wait in the queue until the limit
          resets.
        </p>
      ) : null}
      {/* One frame: the field on top, the hint and Send in a toolbar under it, Send at the bottom right. */}
      <div className={`${styles.field} ${offline ? styles.fieldDisabled : ''}`}>
        <textarea
          ref={input}
          className={styles.input}
          aria-label="Message"
          placeholder={placeholder}
          rows={large ? 4 : 1}
          value={value}
          disabled={offline}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {/* Clicking the toolbar's empty space puts the caret in the field, like clicking the frame. */}
        <div className={styles.toolbar} onMouseDown={focusInput}>
          <p className={styles.hint}>Enter — send, Shift+Enter — new line</p>
          <button
            type="button"
            className={styles.send}
            disabled={offline || value.trim() === ''}
            onClick={submit}
          >
            Send
            <Icon name="send" size="sm" />
          </button>
        </div>
      </div>
    </div>
  );
}
