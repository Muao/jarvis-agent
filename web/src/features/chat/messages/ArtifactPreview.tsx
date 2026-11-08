import type { ArtifactName } from '@jarvis/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useArtifact } from '../../../api/queries';
import { ErrorBlock } from '../../../components/ErrorBlock';
import { Loading } from '../../../components/Loading';
import { Markdown } from '../../../components/Markdown';
import styles from './Card.module.css';

interface ArtifactPreviewProps {
  readonly taskId: string;
  readonly name: ArtifactName;
}

/** The file itself, read in the thread. The owner should not have to leave the chat to review it. */
export function ArtifactPreview({ taskId, name }: ArtifactPreviewProps) {
  const [open, setOpen] = useState(false);
  const taskPath = `/tasks/${encodeURIComponent(taskId)}`;
  return (
    <>
      <button
        type="button"
        className={styles.linkButton}
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        {open ? '▾' : '▸'} {name}
      </button>{' '}
      <Link className={styles.link} to={`${taskPath}?artifact=${encodeURIComponent(name)}`}>
        open full →
      </Link>
      {open ? <ArtifactBody taskId={taskId} name={name} /> : null}
    </>
  );
}

function ArtifactBody({ taskId, name }: ArtifactPreviewProps) {
  const { data, error, isPending, refetch } = useArtifact(taskId, name);
  if (isPending) return <Loading label={`Loading ${name}…`} />;
  if (error) {
    return (
      <ErrorBlock error={error} title={`Could not load ${name}`} onRetry={() => void refetch()} />
    );
  }
  if (!data.exists || data.content === null) {
    return <p className={styles.text}>Not written yet.</p>;
  }
  return (
    <div className={styles.preview}>
      <Markdown>{data.content}</Markdown>
    </div>
  );
}
