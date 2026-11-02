import { useState } from 'react';
import { useAnswerMessage, useCanMutate } from '../../../api/queries';
import { Markdown } from '../../../components/Markdown';
import { formatClock } from '../threadFilters';
import styles from './Card.module.css';
import type { CardProps } from './types';
import { useOnce } from './useOnce';

export function QuestionCard({ message, cancelled }: CardProps<'question'>) {
  const canMutate = useCanMutate();
  const once = useOnce(useAnswerMessage());
  const [text, setText] = useState('');
  const { answer, answeredAt } = message;
  const answeredText = answer !== null && 'text' in answer ? answer.text : null;
  const inactive = answeredText !== null || once.sent || cancelled;
  const disabled = inactive || !canMutate;

  const send = (value: string) => once.submit({ messageId: message.id, body: { text: value } });

  let outcome: string | null = null;
  if (answeredText !== null) {
    outcome = `Answered${answeredAt ? ` · ${formatClock(answeredAt)}` : ''}`;
  } else if (once.sent) {
    outcome = 'Answer sent…';
  } else if (cancelled) {
    outcome = 'Task cancelled';
  }

  return (
    <article
      className={`${styles.card} ${inactive ? styles.inactive : ''}`}
      aria-label={`Question for ${message.body.taskId}`}
    >
      <h3 className={styles.heading}>Question · {message.body.taskId}</h3>
      <Markdown>{message.body.question}</Markdown>
      {answeredText !== null ? <p className={styles.text}>{answeredText}</p> : null}
      {outcome ? <p className={styles.outcome}>{outcome}</p> : null}
      {message.body.options.length > 0 ? (
        <div className={styles.actions} role="group" aria-label="Options">
          {message.body.options.map((option) => (
            <button
              key={option}
              type="button"
              className={styles.button}
              disabled={disabled}
              onClick={() => send(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {!inactive ? (
        <div className={styles.actions}>
          <input
            className={styles.field}
            aria-label="Your answer"
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && text.trim() !== '') send(text.trim());
            }}
          />
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            disabled={disabled || text.trim() === ''}
            onClick={() => send(text.trim())}
          >
            Answer
          </button>
        </div>
      ) : null}
      {once.error ? <p className={styles.error}>Could not send: {once.error.message}</p> : null}
    </article>
  );
}
