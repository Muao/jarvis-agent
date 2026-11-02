import type { Thread } from '../../domain/index.js';
import type { RunIdentity } from '../run-identity.js';
import type { TestApp } from './build-test-app.js';
import { createTaskInNewThread } from './create-task-flow.js';

export const FLOW_PR = { number: 7, url: 'https://github.com/o/r/pull/7' };

/** The identity of the nth process the fake runner started, as the MCP server would resolve it from the run token. */
export function identityOfProcess(app: TestApp, index: number): RunIdentity {
  const process = app.runner.processes[index];
  if (process === undefined) throw new Error(`test: no process #${index}`);
  return app.resolveRunIdentity.execute(process.spec.runToken);
}

/**
 * A task that went the whole way, through the use cases: Context (run 1 reads a file, the spec is
 * submitted, run 1 ends), approval, Implementing (run 2 is live), a failed and a passed check, a
 * draft PR, and one watcher poll that saw one CI check passed and one still running.
 * Meant for apps built with `realRuns: true`.
 */
export async function taskInPrOpen(
  app: TestApp,
): Promise<{ thread: Thread; taskId: string; worker: RunIdentity }> {
  const { thread, taskId } = await createTaskInNewThread(app);
  const first = app.runner.processes[0];
  if (first === undefined) throw new Error('test: the worker did not start');
  await first.reportSession('claude-1');
  await first.emit({
    kind: 'tool_use',
    payload: { toolUseId: 'tu-1', name: 'Read', input: { file_path: '/repo/README.md' } },
  });
  await first.emit({
    kind: 'tool_result',
    payload: { toolUseId: 'tu-1', content: 'readme', isError: false },
  });
  app.artifacts.write(taskId, 'spec.md', '# Spec');
  app.artifacts.write(taskId, 'plan.md', '# Plan');
  app.clock.advanceMinutes(5);
  const { cardId } = await app.submitSpec.execute(identityOfProcess(app, 0), {
    summary: 'Add /health',
  });
  await first.succeed(0.5);

  app.clock.advanceMinutes(2);
  await app.answerDecision.execute(cardId, { decision: 'approve' });
  const worker = identityOfProcess(app, 1);
  app.clock.advanceMinutes(3);
  await app.reportStage.execute(worker, { stage: 'Verifying' });
  await app.reportChecks.execute(worker, { passed: false, summary: 'lint broke' });
  await app.reportChecks.execute(worker, { passed: true, summary: 'all green' });
  app.clock.advanceMinutes(4);
  await app.reportPr.execute(worker, FLOW_PR);
  app.codeHost.set(FLOW_PR.number, {
    headSha: 'abcdef1234567',
    checks: [
      { id: 1, name: 'build', status: 'completed', conclusion: 'success', url: 'https://ci/1' },
      { id: 2, name: 'lint', status: 'in_progress', conclusion: null },
    ],
    reviews: [],
    comments: [],
  });
  app.clock.advanceMinutes(1);
  await app.pollPullRequests.execute();
  return { thread, taskId, worker };
}
