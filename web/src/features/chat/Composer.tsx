import type { KeyboardEvent } from 'react';
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
      <div className={styles.row}>
        <textarea
          className={styles.input}
          aria-label="Message"
          placeholder={placeholder}
          rows={large ? 5 : 2}
          value={value}
          disabled={offline}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
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
      <p className={styles.hint}>Enter — send, Shift+Enter — new line</p>
    </div>
  );
}
