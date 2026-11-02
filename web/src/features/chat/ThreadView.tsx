import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ThreadDetailDto } from '@jarvis/shared';
import { useCanMutate, useOverview, usePostMessage, useThread } from '../../api/queries';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { StageBadge } from '../../components/StageBadge';
import { Composer } from './Composer';
import { MessageItem, OwnerBubble } from './messages/MessageItem';
import { ThreadMenu } from './ThreadMenu';
import styles from './ThreadView.module.css';

interface FailedSend {
  id: number;
  text: string;
}

const STATUS_QUESTION = "What's the current status?";

export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  if (thread.isPending) return <Loading label="Loading thread…" />;
  if (thread.isError) {
    return (
      <ErrorBlock
        error={thread.error}
        title="Could not load this thread"
        onRetry={() => void thread.refetch()}
      />
    );
  }
  return <LoadedThread key={threadId} thread={thread.data} />;
}

function LoadedThread({ thread }: { thread: ThreadDetailDto }) {
  const canMutate = useCanMutate();
  const overview = useOverview();
  const post = usePostMessage(thread.id);
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState<FailedSend[]>([]);
  const nextId = useRef(0);
  const feed = useRef<HTMLDivElement>(null);

  const send = (text: string) => {
    post.mutate(
      { text },
      {
        onError: () => {
          nextId.current += 1;
          setFailed((list) => [...list, { id: nextId.current, text }]);
        },
      },
    );
  };

  const retryFailed = (entry: FailedSend) => {
    setFailed((list) => list.filter((item) => item.id !== entry.id));
    send(entry.text);
  };

  // In a task thread free text goes to the worker, so Status only brings the status card into view;
  // without a task the question goes to the dispatcher (DSP-05).
  const showStatus = () => {
    if (thread.taskId === null) {
      send(STATUS_QUESTION);
      return;
    }
    const card = feed.current?.querySelector<HTMLElement>(`[data-status-card="${thread.taskId}"]`);
    card?.scrollIntoView?.({ block: 'center' });
    card?.focus();
  };

  const lastMessage = thread.messages.at(-1)?.id;
  useEffect(() => {
    const element = feed.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lastMessage, failed.length, thread.dispatcherBusy]);

  const cancelled = thread.stage === 'Cancelled';
  const paused = overview.data?.usage.paused ?? false;

  return (
    <section className={styles.view} aria-label={thread.title}>
      <header className={styles.header}>
        <h1 className={styles.title}>{thread.title}</h1>
        {thread.taskId ? (
          <Link className={styles.link} to={`/tasks/${encodeURIComponent(thread.taskId)}`}>
            {thread.taskId} →
          </Link>
        ) : null}
        {thread.prNumber !== null && thread.prUrl ? (
          <a className={styles.link} href={thread.prUrl} target="_blank" rel="noreferrer">
            PR #{thread.prNumber} ↗
          </a>
        ) : null}
        {thread.stage ? <StageBadge stage={thread.stage} /> : null}
        <ThreadMenu thread={thread} onStatus={showStatus} />
      </header>
      <div className={styles.feed} ref={feed} role="log" aria-label="Messages">
        {thread.messages.map((message) => (
          <MessageItem key={message.id} message={message} cancelled={cancelled} onRetry={send} />
        ))}
        {failed.map((entry) => (
          <OwnerBubble
            key={`failed-${entry.id}`}
            message={failedMessage(thread.id, entry)}
            onRetry={() => retryFailed(entry)}
          />
        ))}
      </div>
      <Composer
        value={draft}
        onValueChange={setDraft}
        onSend={send}
        offline={!canMutate}
        paused={paused}
        thinking={thread.dispatcherBusy}
      />
    </section>
  );
}

/** A send that never reached the engine, shown as a failed owner message. */
function failedMessage(threadId: string, entry: FailedSend) {
  return {
    id: `local-${entry.id}`,
    threadId,
    createdAt: new Date().toISOString(),
    answer: null,
    answeredAt: null,
    kind: 'owner' as const,
    body: { text: entry.text, delivery: 'failed' as const, source: 'owner' as const },
  };
}
