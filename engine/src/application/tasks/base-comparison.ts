import { join } from 'node:path';
import type { TaskEvent } from '../../domain/index.js';
import type { BranchPublisher } from '../ports/branch-publisher.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { CheckResult, CheckRunner } from '../ports/check-runner.js';
import type { TaskDeps } from './deps.js';
import { transact } from '../transaction.js';

/** A real outcome: the command ran to an exit code or hit its timeout. A killed command is neither. */
const isReal = (r: CheckResult): boolean => r.exitCode !== null || r.timedOut;
const isRedResult = (r: CheckResult): boolean => r.exitCode !== 0 || r.timedOut;

/** `check_base_result` rows already journalled for this merge base: command → was it red there. */
function cachedBase(journal: readonly TaskEvent[], baseSha: string): Map<string, boolean> {
  const known = new Map<string, boolean>();
  for (const event of journal) {
    if (event.type !== 'check_base_result' || event.data['baseSha'] !== baseSha) continue;
    const { command, red } = event.data;
    if (typeof command === 'string' && typeof red === 'boolean') known.set(command, red);
  }
  return known;
}

export interface BaseComparisonDeps extends TaskDeps {
  readonly checkRunner: CheckRunner;
  readonly branchPublisher: BranchPublisher;
  readonly artifacts: ArtifactStore;
}

/**
 * Which of the red commands are red on the merge base too, so not the task's to fix. Only the red
 * commands run, only the uncached ones, once per base sha. Anything that goes wrong (the checkout,
 * the run, a command that cannot start or is killed) answers "not red on base": the red stays the
 * task's, and nothing is cached for it.
 */
export async function redOnBase(
  deps: BaseComparisonDeps,
  input: {
    readonly taskId: string;
    readonly reds: readonly string[];
    readonly worktreePath: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly relativeLog: string;
  },
): Promise<{ readonly baseSha: string | null; readonly preexisting: string[] }> {
  const { taskId, reds } = input;
  try {
    const baseSha = await deps.branchPublisher.mergeBase(taskId);
    const journal = await transact(deps, (tx) => tx.journal.list(taskId));
    const known = cachedBase(journal, baseSha);
    const todo = reds.filter((c) => !known.has(c));
    if (todo.length > 0) {
      const outcome = await deps.branchPublisher.onBase(taskId, baseSha, () =>
        deps.checkRunner.run({
          cwd: input.worktreePath,
          commands: todo,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          onProgress: () => undefined,
          logPath: join(deps.artifacts.dirFor(taskId), input.relativeLog),
        }),
      );
      const real = outcome.results.filter(isReal);
      if (!input.signal.aborted && real.length > 0) {
        await transact(deps, async (tx) => {
          for (const r of real) {
            known.set(r.command, isRedResult(r));
            await deps.writer.note(tx, taskId, 'check_base_result', 'system', {
              command: r.command,
              baseSha,
              red: isRedResult(r),
            });
          }
        });
      }
    }
    return { baseSha, preexisting: reds.filter((c) => known.get(c) === true) };
  } catch {
    return { baseSha: null, preexisting: [] };
  }
}
