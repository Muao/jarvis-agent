import type { RunEvent } from '@jarvis/shared';

export type EventFilter = 'all' | 'messages' | 'tools' | 'errors' | 'system';

export const FILTERS: { value: EventFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'messages', label: 'Messages' },
  { value: 'tools', label: 'Tool calls' },
  { value: 'errors', label: 'Errors' },
  { value: 'system', label: 'System' },
];

type ToolResultEvent = Extract<RunEvent, { kind: 'tool_result' }>;

export type TimelineItem =
  | { type: 'text'; base: Base; text: string }
  | {
      type: 'tool';
      base: Base;
      toolUseId: string;
      name: string;
      input: Record<string, unknown> | null;
      result: ToolResultEvent | null;
      /** Subagent name when this call is a `Task` spawn. */
      subagent: string | null;
      children: TimelineItem[];
    }
  | {
      type: 'permission';
      base: Base;
      permissionId: string;
      toolName: string;
      decision: 'pending' | 'allow' | 'deny' | 'timeout';
    }
  | { type: 'system'; base: Base; subtype: string; message: string | null }
  | {
      type: 'result';
      base: Base;
      subtype: string;
      isError: boolean;
      turns: number;
      durationMs: number;
      text: string | null;
    }
  | { type: 'error'; base: Base; message: string };

interface Base {
  /** Stable row key. */
  key: string;
  seq: number;
  at: string;
  /** Changes whenever anything shown by the row (or its children) changes; drives memoisation. */
  sig: string;
  /** Lower-cased searchable text of this item alone. */
  haystack: string;
  /** Filters this item or any descendant belongs to. */
  filters: ReadonlySet<EventFilter>;
  /** Number of errors in this item and its descendants. */
  errors: number;
}

const MAX_HAYSTACK = 40_000;

function clip(text: string): string {
  return (text.length > MAX_HAYSTACK ? text.slice(0, MAX_HAYSTACK) : text).toLowerCase();
}

function subagentName(input: Record<string, unknown>): string | null {
  const type = input['subagent_type'];
  if (typeof type === 'string' && type !== '') return type;
  const description = input['description'];
  return typeof description === 'string' && description !== '' ? description : null;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

interface Draft {
  item: TimelineItem;
  ownFilters: EventFilter[];
  ownErrors: number;
}

/** Folds the flat event list into rows: tool results join their call; subagent events nest under it. */
export function buildTimeline(events: readonly RunEvent[]): TimelineItem[] {
  const roots: Draft[] = [];
  const tools = new Map<string, Draft>();
  const permissions = new Map<string, Draft>();
  const childrenOf = new Map<Draft, Draft[]>();

  const place = (draft: Draft, parent: string | undefined) => {
    const host = parent ? tools.get(parent) : undefined;
    if (host) {
      const list = childrenOf.get(host) ?? [];
      list.push(draft);
      childrenOf.set(host, list);
    } else roots.push(draft);
  };

  const makeBase = (event: RunEvent, haystack: string): Base => ({
    key: `e${event.seq}`,
    seq: event.seq,
    at: event.at,
    sig: String(event.seq),
    haystack: clip(haystack),
    filters: new Set(),
    errors: 0,
  });

  for (const event of events) {
    switch (event.kind) {
      case 'text': {
        const item: TimelineItem = {
          type: 'text',
          base: makeBase(event, event.payload.text),
          text: event.payload.text,
        };
        place({ item, ownFilters: ['messages'], ownErrors: 0 }, event.parentToolUseId);
        break;
      }
      case 'tool_use': {
        const { toolUseId, name, input } = event.payload;
        const existing = tools.get(toolUseId);
        if (existing && existing.item.type === 'tool') {
          // A result arrived before its call (out-of-order delivery): complete the stub.
          existing.item.name = name;
          existing.item.input = input;
          existing.item.subagent = name === 'Task' ? subagentName(input) : null;
          existing.item.base = {
            ...existing.item.base,
            haystack: clip(`${name} ${stringify(input)}`),
          };
          break;
        }
        const item: TimelineItem = {
          type: 'tool',
          base: makeBase(event, `${name} ${stringify(input)}`),
          toolUseId,
          name,
          input,
          result: null,
          subagent: name === 'Task' ? subagentName(input) : null,
          children: [],
        };
        const draft: Draft = { item, ownFilters: ['tools'], ownErrors: 0 };
        tools.set(toolUseId, draft);
        place(draft, event.parentToolUseId);
        break;
      }
      case 'tool_result': {
        let draft = tools.get(event.payload.toolUseId);
        if (!draft) {
          const item: TimelineItem = {
            type: 'tool',
            base: makeBase(event, ''),
            toolUseId: event.payload.toolUseId,
            name: 'unknown tool',
            input: null,
            result: null,
            subagent: null,
            children: [],
          };
          draft = { item, ownFilters: ['tools'], ownErrors: 0 };
          tools.set(event.payload.toolUseId, draft);
          place(draft, event.parentToolUseId);
        }
        if (draft.item.type === 'tool') {
          draft.item.result = event;
          draft.item.base = {
            ...draft.item.base,
            haystack: clip(`${draft.item.base.haystack} ${event.payload.content}`),
            sig: `${draft.item.base.seq}`,
          };
          if (event.payload.isError) {
            draft.ownFilters = ['tools', 'errors'];
            draft.ownErrors = 1;
          }
        }
        break;
      }
      case 'permission': {
        const { permissionId, toolName, decision } = event.payload;
        const known = permissions.get(permissionId);
        if (known && known.item.type === 'permission') {
          known.item.decision = decision;
          break;
        }
        const item: TimelineItem = {
          type: 'permission',
          base: makeBase(event, `permission ${toolName}`),
          permissionId,
          toolName,
          decision,
        };
        const draft: Draft = { item, ownFilters: ['tools'], ownErrors: 0 };
        permissions.set(permissionId, draft);
        place(draft, event.parentToolUseId);
        break;
      }
      case 'system': {
        const item: TimelineItem = {
          type: 'system',
          base: makeBase(event, `${event.payload.subtype} ${event.payload.message ?? ''}`),
          subtype: event.payload.subtype,
          message: event.payload.message ?? null,
        };
        place({ item, ownFilters: ['system'], ownErrors: 0 }, event.parentToolUseId);
        break;
      }
      case 'result': {
        const { payload } = event;
        const item: TimelineItem = {
          type: 'result',
          base: makeBase(event, `${payload.subtype} ${payload.text ?? ''}`),
          subtype: payload.subtype,
          isError: payload.isError,
          turns: payload.turns,
          durationMs: payload.durationMs,
          text: payload.text ?? null,
        };
        place(
          {
            item,
            ownFilters: payload.isError ? ['system', 'errors'] : ['system'],
            ownErrors: payload.isError ? 1 : 0,
          },
          event.parentToolUseId,
        );
        break;
      }
      case 'error': {
        const item: TimelineItem = {
          type: 'error',
          base: makeBase(event, event.payload.message),
          message: event.payload.message,
        };
        place({ item, ownFilters: ['errors'], ownErrors: 1 }, event.parentToolUseId);
        break;
      }
    }
  }

  const finish = (draft: Draft): TimelineItem => {
    const kids = (childrenOf.get(draft) ?? []).map(finish);
    const filters = new Set<EventFilter>(['all', ...draft.ownFilters]);
    let errors = draft.ownErrors;
    for (const kid of kids) {
      for (const f of kid.base.filters) filters.add(f);
      errors += kid.base.errors;
    }
    const item = draft.item;
    const decision = item.type === 'permission' ? item.decision : '';
    const resultSeq = item.type === 'tool' && item.result ? item.result.seq : '';
    const sig = `${item.base.seq}|${resultSeq}|${decision}|${kids.map((k) => k.base.sig).join(',')}`;
    const base: Base = { ...item.base, filters, errors, sig };
    if (item.type === 'tool') return { ...item, base, children: kids };
    return { ...item, base };
  };

  return roots.map(finish);
}

/** Items whose own or nested content passes the filter and the (lower-cased) search text. */
export function filterTimeline(
  items: readonly TimelineItem[],
  filter: EventFilter,
  query: string,
): TimelineItem[] {
  const needle = query.trim().toLowerCase();
  const deepMatch = (item: TimelineItem): boolean =>
    item.base.haystack.includes(needle) || (item.type === 'tool' && item.children.some(deepMatch));
  return items.filter(
    (item) => item.base.filters.has(filter) && (needle === '' || deepMatch(item)),
  );
}

/** Wall-clock gap between a call and its result. */
export function toolDurationMs(item: Extract<TimelineItem, { type: 'tool' }>): number | null {
  if (!item.result) return null;
  const ms = Date.parse(item.result.at) - Date.parse(item.base.at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
