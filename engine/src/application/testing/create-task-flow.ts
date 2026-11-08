import type { Thread } from '../../domain/index.js';
import type { TestApp } from './build-test-app.js';

/**
 * What the dispatcher does for a code request: a thread and a task created through the use case,
 * which asks the scheduler for a worker run. Meant for apps built with `realRuns: true`.
 */
export async function createTaskInNewThread(
  app: TestApp,
  input: { title?: string; description?: string } = {},
): Promise<{ thread: Thread; taskId: string }> {
  const thread = await app.seed.thread();
  const created = await app.createTask.execute(app.identity.dispatcher(thread.id), {
    title: input.title ?? 'Add endpoint',
    description: input.description ?? 'Add a health endpoint.',
  });
  return { thread, taskId: created.taskId };
}

/** The system messages of a thread, oldest first, as plain text. */
export function systemTexts(app: TestApp, threadId: string): string[] {
  return app
    .messagesOf(threadId)
    .filter((m) => m.kind === 'system')
    .map((m) => String(m.body.text));
}
