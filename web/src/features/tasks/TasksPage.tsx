import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { TaskDto } from '@jarvis/shared';
import { useTasks } from '../../api/queries';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { RelativeTime } from '../../components/RelativeTime';
import { StageBadge } from '../../components/StageBadge';
import { CheckStatus } from './CheckStatus';
import { formatTokenCount, formatUsd } from './format';
import { filterTasks, TASK_FILTERS, type TaskFilter } from './taskFilters';
import table from './Table.module.css';
import styles from './TasksPage.module.css';

export function TasksPage() {
  const { data, error, isPending, refetch } = useTasks();
  const [filter, setFilter] = useState<TaskFilter>('All');
  const [search, setSearch] = useState('');

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Tasks</h1>
      {isPending ? <Loading label="Loading tasks…" /> : null}
      {error ? (
        <ErrorBlock error={error} title="Could not load tasks" onRetry={() => void refetch()} />
      ) : null}
      {data && data.length === 0 ? (
        <EmptyState
          title="Ще немає задач. Поставте першу в Chat"
          action={<Link to="/chat">Відкрити Chat</Link>}
        />
      ) : null}
      {data && data.length > 0 ? (
        <>
          <div className={styles.controls}>
            <div role="group" aria-label="Filter by status" className={styles.filters}>
              {TASK_FILTERS.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={filter === name}
                  className={styles.filter}
                  onClick={() => setFilter(name)}
                >
                  {name}
                </button>
              ))}
            </div>
            <input
              type="search"
              aria-label="Search by title or ID"
              placeholder="Search by title or ID"
              className={styles.search}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <TasksTable tasks={filterTasks(data, filter, search)} />
        </>
      ) : null}
    </div>
  );
}

function TasksTable({ tasks }: { tasks: TaskDto[] }) {
  const navigate = useNavigate();
  if (tasks.length === 0) {
    return <EmptyState title="No tasks match" description="Change the filter or the search." />;
  }
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Title</th>
            <th scope="col">Stage</th>
            <th scope="col">Waiting for</th>
            <th scope="col">Branch</th>
            <th scope="col">PR</th>
            <th scope="col">CI</th>
            <th scope="col" className={table.numeric}>
              Runs
            </th>
            <th scope="col" className={table.numeric}>
              Tokens
            </th>
            <th scope="col" className={table.numeric}>
              Notional $
            </th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              className={table.clickable}
              onClick={(event) => {
                if (!(event.target instanceof Element) || !event.target.closest('a')) {
                  void navigate(`/tasks/${task.id}`);
                }
              }}
            >
              <td className={table.mono}>
                <Link to={`/tasks/${task.id}`}>{task.id}</Link>
              </td>
              <td>{task.title}</td>
              <td>
                <StageBadge stage={task.stage} working={task.working} />
              </td>
              <td>{task.waitingFor}</td>
              <td className={table.mono}>{task.branch}</td>
              <td>
                {task.prUrl !== null && task.prNumber !== null ? (
                  <a href={task.prUrl} target="_blank" rel="noreferrer">
                    #{task.prNumber}
                  </a>
                ) : (
                  '—'
                )}
              </td>
              <td>{task.ci !== null ? <CheckStatus status={task.ci} /> : '—'}</td>
              <td className={table.numeric}>{task.runCount}</td>
              <td className={table.numeric}>{formatTokenCount(task.tokens)}</td>
              <td className={table.numeric}>{formatUsd(task.costUsd)}</td>
              <td>
                <RelativeTime at={task.updatedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
