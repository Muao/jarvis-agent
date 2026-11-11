import {
  requestPermission,
  type PermissionRequest,
  type Task,
  type TaskEvent,
} from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { IdGenerator } from '../ports/id-generator.js';
import { transact, type Outbox } from '../transaction.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { TaskDeps } from './deps.js';

/**
 * ADR-0022 (amendment 2026-11-11): the check commands run on the host as the engine's user, so a list
 * that grows or changes needs the owner, exactly as the first one did on the spec card. The request
 * is an ordinary permission card; this is the tool name it carries.
 */
export const CHECKS_UPDATE_TOOL = 'jarvis:update_checks';

export interface ChecksRefreshDeps extends TaskDeps {
  readonly ids: IdGenerator;
  readonly config: ConfigProvider;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** True when every command of `fresh` is, character for character, one the owner already approved. */
export const isNarrowing = (fresh: readonly string[], approved: readonly string[]): boolean =>
  fresh.every((command) => approved.includes(command));

/**
 * Whether this exact proposal is already with the owner (or was answered): a `checks_refresh_proposed`
 * row after the latest `checks_fixed` with the same list whose request did not time out. A request
 * that timed out (nobody answered, or the run that raised it ended) may be raised again.
 */
export function alreadyProposed(
  journal: readonly TaskEvent[],
  fixedAt: number,
  fresh: readonly string[],
): boolean {
  const timedOut = new Set(
    journal.filter((e) => e.type === 'permission_timeout').map((e) => e.data['permissionId']),
  );
  return journal
    .slice(fixedAt + 1)
    .some(
      (e) =>
        e.type === 'checks_refresh_proposed' &&
        !timedOut.has(e.data['permissionId']) &&
        strings(e.data['commands']).join('\n') === fresh.join('\n'),
    );
}

/**
 * Journals the proposal and puts a permission card in the task's thread showing the old and the new
 * list. Nothing is run from `fresh`: `open_pr` keeps using the approved list until the owner answers.
 */
export async function proposeChecks(
  deps: ChecksRefreshDeps,
  input: {
    readonly task: Task;
    readonly runId: string;
    readonly previous: readonly string[];
    readonly fresh: readonly string[];
  },
): Promise<void> {
  const { task, previous, fresh } = input;
  const added = fresh.filter((command) => !previous.includes(command));
  const request = requestPermission({
    id: deps.ids.permissionId(),
    runId: input.runId,
    threadId: task.threadId,
    taskId: task.id,
    tool: CHECKS_UPDATE_TOOL,
    description: `main's AGENTS.md now lists check commands you have not approved. Jarvis runs them on your machine as your user. Approve to use the new list, deny to keep the current one. Until you answer, ${task.id} keeps running the approved list.`,
    input: { previous: [...previous], proposed: [...fresh], added },
    at: deps.clock.now(),
    timeoutMinutes: deps.config.current().limits.permissionTimeoutMinutes,
  });
  await transact(deps, async (tx, outbox) => {
    await tx.permissions.save(request);
    const body: BodyOf<'permission'> = {
      permissionId: request.id,
      requester: 'engine',
      toolName: request.tool,
      description: request.description,
      input: { ...request.input },
    };
    await deps.messages.post(tx, outbox, {
      threadId: task.threadId,
      taskId: task.id,
      kind: 'permission',
      body,
    });
    await deps.writer.note(tx, task.id, 'checks_refresh_proposed', 'system', {
      permissionId: request.id,
      commands: fresh,
      previous,
      added,
    });
    outbox.taskChanged(task);
  });
}

/**
 * The owner answered a `CHECKS_UPDATE_TOOL` request. Allow → the proposed list becomes the frozen one
 * (`checks_fixed`, source `base_refresh_approved`) — but only if it still replaces the list it was
 * proposed against; deny → the approved list stays. Runs inside the answering transaction.
 */
export async function settleChecksRequest(
  deps: Pick<TaskDeps, 'writer'>,
  tx: Repositories,
  _outbox: Outbox,
  request: PermissionRequest,
  decision: 'allow' | 'deny',
  cardId: string | null,
): Promise<void> {
  if (request.tool !== CHECKS_UPDATE_TOOL || request.taskId === null) return;
  const taskId = request.taskId;
  if (decision === 'deny') {
    await deps.writer.note(tx, taskId, 'checks_refresh_denied', 'owner', {
      permissionId: request.id,
    });
    return;
  }
  const journal = await tx.journal.list(taskId);
  let latest: TaskEvent | undefined;
  for (const event of journal) if (event.type === 'checks_fixed') latest = event;
  const proposed = strings(request.input['proposed']);
  const previous = strings(request.input['previous']);
  if (
    proposed.length === 0 ||
    latest === undefined ||
    strings(latest.data['commands']).join('\n') !== previous.join('\n')
  ) {
    // The list moved on since the card was raised: what the owner read is no longer what it replaces.
    await deps.writer.note(tx, taskId, 'checks_refresh_stale', 'system', {
      permissionId: request.id,
    });
    return;
  }
  await deps.writer.note(tx, taskId, 'checks_fixed', 'owner', {
    commands: proposed,
    source: 'base_refresh_approved',
    cardId,
    previous,
    permissionId: request.id,
  });
}
