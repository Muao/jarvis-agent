import { useParams } from 'react-router';
import { useThreads } from '../../api/queries';
import styles from './ChatPage.module.css';
import { NewThread } from './NewThread';
import { ThreadList } from './ThreadList';
import { ThreadView } from './ThreadView';

/** `/chat` and `/chat/:threadId`: thread list on the left, the open thread (or the new-thread prompt) beside it. */
export function ChatPage() {
  const { threadId } = useParams();
  const threads = useThreads();
  return (
    <div className={styles.page}>
      <ThreadList
        threads={threads.data}
        loading={threads.isPending}
        error={threads.error}
        onRetry={() => void threads.refetch()}
        selectedId={threadId}
      />
      {threadId ? <ThreadView threadId={threadId} /> : <NewThread />}
    </div>
  );
}
