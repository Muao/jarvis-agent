import { useState, type CSSProperties } from 'react';
import { useParams } from 'react-router';
import { useThreads } from '../../api/queries';
import { usePersistentState } from '../../app/usePersistentState';
import styles from './ChatPage.module.css';
import { NewThread } from './NewThread';
import { ResizeHandle } from './ResizeHandle';
import { ThreadList } from './ThreadList';
import { ThreadView } from './ThreadView';
import { THREAD_LIST_WIDTH, THREAD_LIST_WIDTH_KEY, parseThreadListWidth } from './threadListWidth';

/** `/chat` and `/chat/:threadId`: thread list on the left, the open thread (or the new-thread prompt) beside it. */
export function ChatPage() {
  const { threadId } = useParams();
  const threads = useThreads();
  const [storedWidth, setStoredWidth] = usePersistentState(
    THREAD_LIST_WIDTH_KEY,
    THREAD_LIST_WIDTH.default,
    parseThreadListWidth,
  );
  // While dragging, the width follows the pointer without writing to storage on every move.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? storedWidth;

  return (
    <div className={styles.page} style={{ '--thread-list-width': `${width}px` } as CSSProperties}>
      <ThreadList
        id="thread-list"
        threads={threads.data}
        loading={threads.isPending}
        error={threads.error}
        onRetry={() => void threads.refetch()}
        selectedId={threadId}
      />
      <ResizeHandle
        label="Resize thread list"
        controls="thread-list"
        value={width}
        min={THREAD_LIST_WIDTH.min}
        max={THREAD_LIST_WIDTH.max}
        defaultValue={THREAD_LIST_WIDTH.default}
        onPreview={setDragWidth}
        onCommit={(next) => {
          setDragWidth(null);
          setStoredWidth(next);
        }}
      />
      {threadId ? <ThreadView threadId={threadId} /> : <NewThread />}
    </div>
  );
}
