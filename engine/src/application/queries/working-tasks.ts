import type { Repositories } from '../ports/unit-of-work.js';

/** The tasks whose worker is running right now, for the `working` flag of a task or thread row. */
export async function workingTasks(tx: Pick<Repositories, 'runs'>): Promise<Set<string>> {
  const running = await tx.runs.listRunning();
  return new Set(
    running.flatMap((run) => (run.role === 'worker' && run.taskId !== null ? [run.taskId] : [])),
  );
}
