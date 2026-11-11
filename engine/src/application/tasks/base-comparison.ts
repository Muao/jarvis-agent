import { join } from 'node:path';
import type { TaskEvent } from '../../domain/index.js';
import type { BranchPublisher } from '../ports/branch-publisher.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { RepoInfo } from '../ports/repo-info.js';
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
  readonly repoInfo: RepoInfo;
}

/**
 * Which of the red commands are red on the merge base too, so not the task's to fix. Only the red
 * commands run, only the uncached ones, once per base sha, in a clean checkout the engine makes of
 * the merge base — never in the task's worktree, whose ignored and untracked files (node_modules,
 * caches, `.env`) the worker controls and could use to make a check fail on base as well. Anything that goes wrong (the checkout,
 * the run, a command that cannot start or is killed) answers "not red on base": the red stays the
 * task's, and nothing is cached for it.
 */
export async function redOnBase(
  deps: BaseComparisonDeps,
  input: {
    readonly taskId: string;
    readonly reds: readonly string[];
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly relativeLog: string;
  },
): Promise<{
  readonly baseSha: string | null;
  readonly preexisting: string[];
  /** Set when the comparison itself failed (checkout, run, restore); the red then stays the task's. */
  readonly error: string | null;
}> {
  const { taskId, reds } = input;
  try {
    const baseSha = await deps.branchPublisher.mergeBase(taskId);
    const journal = await transact(deps, (tx) => tx.journal.list(taskId));
    const known = cachedBase(journal, baseSha);
    const todo = reds.filter((c) => !known.has(c));
    if (todo.length > 0) {
      const logPath = join(deps.artifacts.dirFor(taskId), input.relativeLog);
      const outcome = await deps.branchPublisher.withBaseCheckout(taskId, baseSha, async (dir) => {
        // A clean checkout has no node_modules: install from its lockfile first. If that cannot be
        // done the comparison is void (thrown below) and the red stays the task's.
        const install = await deps.repoInfo.installCommand(dir);
        if (install !== null) {
          const installed = await deps.checkRunner.run({
            cwd: dir,
            commands: [install],
            timeoutMs: input.timeoutMs,
            signal: input.signal,
            onProgress: () => undefined,
            logPath,
          });
          const [result] = installed.results;
          if (installed.unavailable !== null || result === undefined || isRedResult(result)) {
            throw new Error(`\`${install}\` did not succeed on the merge base`);
          }
        }
        return deps.checkRunner.run({
          cwd: dir,
          commands: todo,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          onProgress: () => undefined,
          logPath,
        });
      });
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
    return { baseSha, preexisting: reds.filter((c) => known.get(c) === true), error: null };
  } catch (error) {
    return {
      baseSha: null,
      preexisting: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
