import type { MessageDto } from '@jarvis/shared';
import { Markdown } from '../../../components/Markdown';
import styles from './Card.module.css';
import { DecisionCard } from './DecisionCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { ResultCard } from './ResultCard';
import { StatusCard } from './StatusCard';
import type { MessageOf } from './types';

interface MessageItemProps {
  message: MessageDto;
  cancelled: boolean;
  onRetry: (text: string) => void;
}

export function OwnerBubble({
  message,
  onRetry,
}: {
  message: MessageOf<'owner'>;
  onRetry: (text: string) => void;
}) {
  const { text, delivery } = message.body;
  return (
    <div className={styles.bubbleRow}>
      <div className={`${styles.bubble} ${delivery === 'failed' ? styles.failed : ''}`}>
        <p className={styles.text}>{text}</p>
        {delivery === 'delivered' ? null : (
          <span className={delivery === 'failed' ? styles.markDanger : styles.mark}>
            {delivery === 'failed' ? 'failed to send' : 'queued'}
          </span>
        )}
        {delivery === 'failed' ? (
          <button type="button" className={styles.button} onClick={() => onRetry(text)}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Plain text only: owner-typed and automatic text never goes through HTML (SEC-03). */
export function SystemLine({ text }: { text: string }) {
  return <p className={styles.system}>{text}</p>;
}

const SOURCE_LABEL = { ci: 'CI', review: 'Review' } as const;

export function MessageItem({ message, cancelled, onRetry }: MessageItemProps) {
  switch (message.kind) {
    case 'owner': {
      const source = message.body.source;
      if (source !== 'owner') {
        return <SystemLine text={`${SOURCE_LABEL[source]}: ${message.body.text}`} />;
      }
      return <OwnerBubble message={message} onRetry={onRetry} />;
    }
    case 'jarvis':
      return (
        <div className={`${styles.card} ${styles.jarvis}`} aria-label="Jarvis">
          <Markdown>{message.body.text}</Markdown>
        </div>
      );
    case 'status':
      return <StatusCard message={message} />;
    case 'decision':
      return <DecisionCard message={message} cancelled={cancelled} />;
    case 'question':
      return <QuestionCard message={message} cancelled={cancelled} />;
    case 'permission':
      return <PermissionCard message={message} cancelled={cancelled} />;
    case 'result':
      return <ResultCard message={message} />;
    case 'system':
      return <SystemLine text={message.body.text} />;
  }
}
