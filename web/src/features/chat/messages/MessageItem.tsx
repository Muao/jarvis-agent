import type { MessageDto } from '@jarvis/shared';
import { useCanMutate, useSendNow } from '../../../api/queries';
import { Markdown } from '../../../components/Markdown';
import styles from './Card.module.css';
import { DecisionCard } from './DecisionCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { ResultCard } from './ResultCard';
import { StatusCard } from './StatusCard';
import type { MessageOf } from './types';
import { formatMessageTime } from './messageTime';

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
        {delivery === 'queued' && message.taskId !== null ? (
          <SendNowButton messageId={message.id} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The message waits for its task's worker, which is not running: hand it to the dispatcher now,
 * the way Claude Code lets a queued message through.
 */
function SendNowButton({ messageId }: { messageId: string }) {
  const canMutate = useCanMutate();
  const sendNow = useSendNow();
  return (
    <button
      type="button"
      className={styles.button}
      title="The task's worker is not running. Hand this message to the dispatcher, which answers now."
      disabled={!canMutate || sendNow.isPending}
      onClick={() => sendNow.mutate(messageId)}
    >
      Send now
    </button>
  );
}

/** Plain text only: owner-typed and automatic text never goes through HTML (SEC-03). */
export function SystemCard({ text }: { text: string }) {
  return (
    <article className={`${styles.card} ${styles.inactive}`} aria-label="System">
      <h3 className={styles.heading}>system</h3>
      <p className={styles.text}>{text}</p>
    </article>
  );
}

const SOURCE_LABEL = { ci: 'CI', review: 'Review' } as const;

/** Every message carries the time it was posted: the owner must see when things happened. */
export function MessageItem(props: MessageItemProps) {
  const { message } = props;
  const own = message.kind === 'owner' && message.body.source === 'owner';
  const time = formatMessageTime(message.createdAt);
  return (
    <div className={own ? styles.entryOwn : styles.entry}>
      <MessageBody {...props} />
      <time className={styles.time} dateTime={message.createdAt} title={time.full}>
        {time.short}
      </time>
    </div>
  );
}

function MessageBody({ message, cancelled, onRetry }: MessageItemProps) {
  switch (message.kind) {
    case 'owner': {
      const source = message.body.source;
      if (source !== 'owner') {
        return <SystemCard text={`${SOURCE_LABEL[source]}: ${message.body.text}`} />;
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
      return <SystemCard text={message.body.text} />;
  }
}
