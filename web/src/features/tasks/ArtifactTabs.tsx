import { useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import {
  ArtifactNameSchema,
  type ArtifactName,
  type TaskDetailDto,
  type TaskStage,
} from '@jarvis/shared';
import { useArtifact } from '../../api/queries';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { Markdown } from '../../components/Markdown';
import { RelativeTime } from '../../components/RelativeTime';
import styles from './ArtifactTabs.module.css';

const NAMES = ArtifactNameSchema.options;

/** The stage at which the worker normally writes each file; shown when the file does not exist yet. */
const WRITTEN_AT: Record<ArtifactName, TaskStage> = {
  'context.md': 'Context',
  'spec.md': 'Spec Review',
  'plan.md': 'Spec Review',
  'tasks.md': 'Spec Review',
  'result.md': 'PR Open',
};

interface ArtifactTabsProps {
  taskId: string;
  artifacts: TaskDetailDto['artifacts'];
}

export function ArtifactTabs({ taskId, artifacts }: ArtifactTabsProps) {
  const exists = (name: ArtifactName) => artifacts.some((a) => a.name === name && a.exists);
  // `?artifact=<name>` deep-links to a tab (Chat decision cards, "Open result.md").
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<ArtifactName>(() => {
    const wanted = ArtifactNameSchema.safeParse(params.get('artifact'));
    return wanted.success ? wanted.data : (NAMES.find(exists) ?? 'context.md');
  });

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    const next = NAMES[(NAMES.indexOf(selected) + step + NAMES.length) % NAMES.length];
    if (next === undefined) return;
    setSelected(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <div>
      <div role="tablist" aria-label="Artifacts" className={styles.tabs}>
        {NAMES.map((name) => (
          <button
            key={name}
            id={tabId(name)}
            type="button"
            role="tab"
            aria-selected={selected === name}
            aria-controls={panelId}
            tabIndex={selected === name ? 0 : -1}
            className={styles.tab}
            onClick={() => setSelected(name)}
            onKeyDown={onKeyDown}
          >
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(selected)} className={styles.panel}>
        {exists(selected) ? (
          <ArtifactPanel key={selected} taskId={taskId} name={selected} />
        ) : (
          <p className={styles.empty}>Not written yet — appears at stage {WRITTEN_AT[selected]}</p>
        )}
      </div>
    </div>
  );
}

const tabId = (name: ArtifactName) => `artifact-tab-${name}`;
const panelId = 'artifact-panel';

/** One artifact file. Remounted per file, so the "Updated" mark never leaks between tabs. */
function ArtifactPanel({ taskId, name }: { taskId: string; name: ArtifactName }) {
  const { data, error, isPending, refetch } = useArtifact(taskId, name);
  const [baseline, setBaseline] = useState<string | null | undefined>(undefined);
  const [changed, setChanged] = useState(false);

  // Content that changes while the file is open is flagged (ADM-02). Adjusting state while rendering is
  // the documented way to react to a prop change without an effect.
  if (data && baseline !== data.content) {
    setBaseline(data.content);
    if (baseline !== undefined) setChanged(true);
  }

  if (isPending) return <Loading label={`Loading ${name}…`} />;
  if (error) {
    return (
      <ErrorBlock error={error} title={`Could not load ${name}`} onRetry={() => void refetch()} />
    );
  }
  if (!data.exists || data.content === null) {
    return <p className={styles.empty}>Not written yet — appears at stage {WRITTEN_AT[name]}</p>;
  }
  return (
    <>
      <p className={styles.meta}>
        {changed ? (
          <strong>Updated just now</strong>
        ) : data.updatedAt !== null ? (
          <>
            Updated <RelativeTime at={data.updatedAt} />
          </>
        ) : null}
      </p>
      <Markdown>{data.content}</Markdown>
    </>
  );
}
