import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useCanMutate, useCreateThread, useOverview } from '../../api/queries';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Composer } from './Composer';
import styles from './NewThread.module.css';

const EXAMPLES = [
  'Додай сторінку програми курсу за дизайном…',
  'Що в Notion сказано про…',
  'Покажи, що зараз у роботі',
];

/** No thread selected: the first message creates one and opens it. */
export function NewThread() {
  const canMutate = useCanMutate();
  const overview = useOverview();
  const create = useCreateThread();
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');

  const send = async (text: string) => {
    const thread = await create.mutateAsync({ text });
    await navigate(`/chat/${encodeURIComponent(thread.id)}`);
  };

  return (
    <div className={styles.empty}>
      <h1 className={styles.title}>Опишіть задачу або поставте питання</h1>
      <div className={styles.examples} role="group" aria-label="Example prompts">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className={styles.example}
            onClick={() => setDraft(example)}
          >
            {example}
          </button>
        ))}
      </div>
      {create.isError ? (
        <ErrorBlock error={create.error} title="Could not start the thread" />
      ) : null}
      <Composer
        large
        value={draft}
        onValueChange={setDraft}
        onSend={send}
        offline={!canMutate}
        paused={overview.data?.usage.paused ?? false}
        placeholder="Опишіть задачу або поставте питання"
      />
    </div>
  );
}
