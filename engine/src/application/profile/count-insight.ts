import {
  confirmEntry,
  contradictEntry,
  findEntry,
  formatLocalMinute,
  parseMemory,
  spliceMemory,
  type MemoryEntry,
} from '../../domain/index.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';
import { guardMemory, requireBuildTask } from './memory-support.js';

export interface CountInsightDeps extends TaskDeps {
  readonly profile: ProfileStore;
}

export interface CountResult {
  readonly ok: true;
  /** The entry's ✓ (or ✗) after this call; an owner entry has none, so 0. */
  readonly count: number;
  /** False: this task had already counted that entry, and nothing was written. */
  readonly counted: boolean;
}

/**
 * ADR-0021: one ✓ or ✗ for an entry from this task. "Distinct tasks" is decided from the task's
 * own journal events, not from the file: a second call for the same entry from the same task
 * writes nothing.
 */
export async function countOnce(
  deps: CountInsightDeps,
  identity: RunIdentity,
  input: { readonly id: string; readonly reason?: string },
  kind: 'confirmed' | 'contradicted',
): Promise<CountResult> {
  return transact(deps, async (tx, outbox) => {
    const task = await loadWorkerTask(tx, identity);
    requireBuildTask(task);
    const type = `memory_${kind}`;
    const events = await tx.journal.list(task.id);
    const field = kind;

    // The task that noted an entry already counts for it (✓1 from the start).
    const creator =
      kind === 'confirmed' &&
      events.some((e) => e.type === 'memory_noted' && e.data.entryId === input.id);
    if (creator || events.some((e) => e.type === type && e.data.entryId === input.id)) {
      const entry = findEntry(parseMemory(await deps.profile.read()), input.id);
      return { ok: true, count: entry?.[field] ?? 0, counted: false };
    }

    const at = formatLocalMinute(deps.clock.now());
    const apply = kind === 'confirmed' ? confirmEntry : contradictEntry;
    const entry: MemoryEntry = await guardMemory(() =>
      deps.profile.mutate((current) => {
        const result = apply(parseMemory(current), { id: input.id, task: task.id, at });
        return {
          // An owner entry carries no counters: the text goes back unchanged, and nothing is written.
          content: result.changed ? spliceMemory(current, result.document) : current,
          result: result.entry,
        };
      }),
    );

    // A confirmation of an owner entry counts for nothing: the owner's word needs no check.
    if (kind === 'confirmed' && entry.origin === 'owner') {
      return { ok: true, count: 0, counted: false };
    }

    await deps.writer.note(
      tx,
      task.id,
      type,
      'agent',
      kind === 'confirmed' ? { entryId: input.id } : { entryId: input.id, reason: input.reason },
    );
    if (kind === 'contradicted' && entry.origin === 'owner') {
      // Nothing changes in the file; the owner hears about it instead.
      await deps.messages.post(tx, outbox, {
        threadId: task.threadId,
        taskId: task.id,
        kind: 'system',
        body: {
          text: `Memory ${input.id} ("${entry.fact}") was set by you; ${task.id} found it contradicted: ${input.reason ?? ''}. The entry is unchanged.`,
        },
      });
    }
    return { ok: true, count: entry[field], counted: true };
  });
}
