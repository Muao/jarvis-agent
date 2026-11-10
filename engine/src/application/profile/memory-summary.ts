import type { TaskEvent } from '../../domain/index.js';

/**
 * ADR-0021: the one line the owner sees when a task ends, built from the task's journal. Null when
 * the task touched the memory not at all.
 */
export function memorySummaryLine(events: readonly TaskEvent[], overCap = false): string | null {
  const ids = (type: string): string[] => [
    ...new Set(
      events
        .filter((e) => e.type === type)
        .map((e) => e.data.entryId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const noted = ids('memory_noted');
  const confirmed = ids('memory_confirmed');
  const contradicted = ids('memory_contradicted');
  const recorded = ids('memory_owner_recorded');
  if (noted.length + confirmed.length + contradicted.length + recorded.length === 0) return null;

  const head = [
    `${noted.length} noted`,
    `${confirmed.length} confirmed`,
    `${contradicted.length} contradicted`,
    ...(recorded.length > 0 ? [`${recorded.length} recorded from your words`] : []),
  ];
  const named = [
    ['noted', noted],
    ['confirmed', confirmed],
    ['contradicted', contradicted],
    ['recorded', recorded],
  ].flatMap(([label, list]) =>
    (list as string[]).length === 0 ? [] : [`${(list as string[]).join(', ')} ${label as string}`],
  );
  const cap = overCap ? ' Memory is over its cap — ask me to review it.' : '';
  return `Memory: ${head.join(', ')} — ${named.join('; ')}.${cap}`;
}
