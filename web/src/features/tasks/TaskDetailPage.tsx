import { Link, useParams } from 'react-router';
import { ApiError, useTask } from '../../api/queries';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { ArtifactTabs } from './ArtifactTabs';
import { Block } from './Block';
import { JournalList } from './JournalList';
import { PullRequestBlock } from './PullRequestBlock';
import { RunsTable } from './RunsTable';
import { TaskHeader } from './TaskHeader';
import { Timeline } from './Timeline';
import styles from './TaskDetailPage.module.css';

export function TaskDetailPage() {
  const { taskId } = useParams();
  const { data: task, error, isPending, refetch } = useTask(taskId);

  if (isPending) return <Loading label="Loading task…" />;
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className={styles.page}>
        <EmptyState
          title="Task not found"
          description={`There is no task ${taskId ?? ''}.`}
          action={<Link to="/tasks">Back to Tasks</Link>}
        />
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.page}>
        <ErrorBlock error={error} title="Could not load the task" onRetry={() => void refetch()} />
      </div>
    );
  }

  const now = new Date();
  return (
    <div className={styles.page}>
      <nav aria-label="Breadcrumb">
        <Link to="/tasks">← Tasks</Link>
      </nav>
      <TaskHeader task={task} now={now} />
      <Block title="Stage timeline">
        <Timeline stages={task.stages} now={now} />
      </Block>
      <Block title="Artifacts">
        <ArtifactTabs taskId={task.id} artifacts={task.artifacts} />
      </Block>
      <Block title="PR · CI · Review">
        <PullRequestBlock task={task} />
      </Block>
      <Block title="Runs">
        <RunsTable runs={task.runs} now={now} />
      </Block>
      <Block title="Journal">
        <JournalList entries={task.journal} />
      </Block>
    </div>
  );
}
