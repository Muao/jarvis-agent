import type { IsoTime } from './time.js';

/**
 * ADR-0021: the `## Learned` section of `USER.md` as a document. Pure — no file access and no clock;
 * time and the task id come in as arguments, so the same operation on the same text always gives
 * the same result. Every operation returns a new document; `spliceMemory` is the only way back
 * into a file, and it replaces the section's bytes and nothing else.
 */

export type MemoryErrorCode =
  | 'unknown_entry'
  | 'scope_mismatch'
  | 'invalid_fact'
  | 'invalid_citation'
  | 'invalid_task'
  | 'invalid_time'
  | 'invalid_scope'
  | 'too_few_entries';

/** The only error this module throws; callers map `code` to their own error types. */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export const MAX_FACT_CHARS = 300;

/** One entry. Owner entries carry no counters; an agent entry starts at ✓1 ✗0. */
export interface MemoryEntry {
  /** `m<N>`; null only for a hand-written bullet that no write has numbered yet. */
  readonly id: string | null;
  readonly origin: 'owner' | 'agent';
  /** `owner/name`, or null for an entry that applies everywhere. */
  readonly scope: string | null;
  readonly fact: string;
  /** Local `YYYY-MM-DD HH:mm`; null for a hand-written entry. */
  readonly at: string | null;
  /** The task that noted an agent entry, or the task an owner entry was recorded `via`. */
  readonly task: string | null;
  /** Owner entries only: where the words came from (e.g. `message 0193…`). */
  readonly source: string | null;
  /** Agent entries only. */
  readonly citations: readonly string[];
  readonly confirmed: number;
  readonly contradicted: number;
  /** The task and time of the last confirmation or contradiction. */
  readonly last: { readonly task: string; readonly at: string } | null;
}

export type MemoryLine =
  | { readonly kind: 'text'; readonly raw: string }
  | { readonly kind: 'scope'; readonly raw: string; readonly scope: string }
  | {
      readonly kind: 'entry';
      readonly entry: MemoryEntry;
      /** The original bytes of the line; null once an operation has rewritten the entry. */
      readonly raw: string | null;
    };

export interface MemoryDocument {
  /** False when the file has no `## Learned` heading yet; `spliceMemory` then appends one. */
  readonly present: boolean;
  /** The section split on `\n`, the heading line first; joining with `\n` restores it exactly. */
  readonly lines: readonly MemoryLine[];
}

const HEADING = '## Learned';
const TIME = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}';
const TIME_RE = new RegExp(`^${TIME}$`);
const TASK_RE = /^T-\d+$/;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;
const ENTRY_RE = /^- (m\d+) \[([^\]]*)\] (.+)$/;
const OWNER_PREFIX = new RegExp(`^owner(?: via (T-\\d+))?(?: · (${TIME}))?$`);
const AGENT_PREFIX = new RegExp(
  `^agent · (T-\\d+) · (${TIME}) · ✓(\\d+) ✗(\\d+)(?: · last (T-\\d+) (${TIME}))?$`,
);
const SRC_TAIL = /^(.+) \(src: (.*)\)$/;
const LEGACY_BULLET = /^[-*] (.+)$/;
const SCOPE_HEADING = /^### (.+?)\s*$/;

// ── time ───────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * `YYYY-MM-DD HH:mm` in the machine's local zone — the same notion of "local" as
 * `startOfLocalDay` (it reads the zone through `Date`'s local accessors).
 */
export function formatLocalMinute(time: IsoTime): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── parsing ────────────────────────────────────────────────────────────────────────────────────

function parseEntryLine(raw: string, scope: string | null): MemoryEntry {
  const m = ENTRY_RE.exec(raw);
  if (m !== null) {
    const [, id, prefix, rest] = m as unknown as [string, string, string, string];
    const tail = SRC_TAIL.exec(rest);
    const fact = tail === null ? rest : (tail[1] ?? rest);
    const src = tail === null ? null : (tail[2] ?? '');
    const owner = OWNER_PREFIX.exec(prefix);
    if (owner !== null) {
      return {
        id,
        origin: 'owner',
        scope,
        fact,
        at: owner[2] ?? null,
        task: owner[1] ?? null,
        source: src,
        citations: [],
        confirmed: 0,
        contradicted: 0,
        last: null,
      };
    }
    const agent = AGENT_PREFIX.exec(prefix);
    if (agent !== null) {
      return {
        id,
        origin: 'agent',
        scope,
        fact,
        at: agent[2] as string,
        task: agent[1] as string,
        source: null,
        citations: src === null || src === '' ? [] : src.split(', '),
        confirmed: Number(agent[3]),
        contradicted: Number(agent[4]),
        last:
          agent[5] !== undefined && agent[6] !== undefined
            ? { task: agent[5], at: agent[6] }
            : null,
      };
    }
  }
  // No recognised prefix: a hand-written bullet is an owner entry, kept as written until numbered.
  const bullet = LEGACY_BULLET.exec(raw);
  return {
    id: null,
    origin: 'owner',
    scope,
    fact: bullet?.[1] ?? raw,
    at: null,
    task: null,
    source: null,
    citations: [],
    confirmed: 0,
    contradicted: 0,
    last: null,
  };
}

function isEntryLine(raw: string): boolean {
  return LEGACY_BULLET.test(raw);
}

function parseLines(text: string): MemoryLine[] {
  let scope: string | null = null;
  let inComment = false;
  return text.split('\n').map((raw, index): MemoryLine => {
    if (index === 0) return { kind: 'text', raw };
    const wasInComment = inComment;
    // Lines inside an HTML comment (the format example in USER.example.md) are not entries.
    const open = raw.lastIndexOf('<!--');
    const close = raw.lastIndexOf('-->');
    if (open !== -1 && close < open) inComment = true;
    else if (inComment && close !== -1) inComment = false;
    if (wasInComment || open !== -1) return { kind: 'text', raw };

    const heading = SCOPE_HEADING.exec(raw);
    if (heading !== null) {
      scope = heading[1] as string;
      return { kind: 'scope', raw, scope };
    }
    if (isEntryLine(raw)) return { kind: 'entry', entry: parseEntryLine(raw, scope), raw };
    return { kind: 'text', raw };
  });
}

/** Bounds of `## Learned` in `content`: its heading line up to the next `## ` heading or the end. */
function sectionBounds(content: string): { start: number; end: number } | null {
  const heading = /^## Learned[ \t]*$/m.exec(content);
  if (heading === null) return null;
  const start = heading.index;
  const afterHeading = start + heading[0].length;
  const next = /^## /m.exec(content.slice(afterHeading));
  return { start, end: next === null ? content.length : afterHeading + next.index };
}

/** Everything of `content` outside `## Learned`, joined — what the owner wrote by hand. */
export function outsideLearned(content: string): string {
  const bounds = sectionBounds(content);
  return bounds === null ? content : content.slice(0, bounds.start) + content.slice(bounds.end);
}

export function parseMemory(content: string): MemoryDocument {
  const bounds = sectionBounds(content);
  if (bounds === null) {
    return { present: false, lines: parseLines(`${HEADING}\n`) };
  }
  return { present: true, lines: parseLines(content.slice(bounds.start, bounds.end)) };
}

// ── rendering ──────────────────────────────────────────────────────────────────────────────────

/** `(src:` inside a fact would read back as the citation tail; keep it from forming one. */
function sanitizeFact(fact: string): string {
  const trimmed = fact.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_FACT_CHARS || /[\r\n]/.test(trimmed)) {
    throw new MemoryError(
      'invalid_fact',
      `A fact is one line of 1–${MAX_FACT_CHARS} characters, without a line break.`,
    );
  }
  return trimmed.replace(/\(src:/g, '(src :');
}

/** One entry as a line. An entry nobody has numbered renders as the plain bullet it was. */
export function renderEntry(entry: MemoryEntry): string {
  if (entry.id === null) return `- ${entry.fact}`;
  if (entry.origin === 'owner') {
    const via = entry.task === null ? '' : ` via ${entry.task}`;
    const at = entry.at === null ? '' : ` · ${entry.at}`;
    const src = entry.source === null ? '' : ` (src: ${entry.source})`;
    return `- ${entry.id} [owner${via}${at}] ${entry.fact}${src}`;
  }
  const last = entry.last === null ? '' : ` · last ${entry.last.task} ${entry.last.at}`;
  const src = entry.citations.length === 0 ? '' : ` (src: ${entry.citations.join(', ')})`;
  return `- ${entry.id} [agent · ${entry.task ?? ''} · ${entry.at ?? ''} · ✓${entry.confirmed} ✗${entry.contradicted}${last}] ${entry.fact}${src}`;
}

/** The section's text, heading included — what `read_memory` returns. */
export function renderMemory(document: MemoryDocument): string {
  return document.lines
    .map((line) =>
      line.kind === 'entry' && line.raw === null ? renderEntry(line.entry) : line.raw,
    )
    .join('\n');
}

/**
 * Puts `document` back into `content`, replacing only the bytes of `## Learned`. Without the
 * heading it is appended at the end of the file (ADR-0013), after a blank line.
 */
export function spliceMemory(content: string, document: MemoryDocument): string {
  const text = renderMemory(document);
  const bounds = sectionBounds(content);
  if (bounds === null) {
    const base = content.length === 0 ? '' : content.endsWith('\n') ? content : `${content}\n`;
    return `${base}${base.length === 0 ? '' : '\n'}${text}`;
  }
  return content.slice(0, bounds.start) + text + content.slice(bounds.end);
}

// ── reading ────────────────────────────────────────────────────────────────────────────────────

export function memoryEntries(document: MemoryDocument): MemoryEntry[] {
  return document.lines.flatMap((line) => (line.kind === 'entry' ? [line.entry] : []));
}

export function findEntry(document: MemoryDocument, id: string): MemoryEntry | undefined {
  return memoryEntries(document).find((entry) => entry.id === id);
}

function nextId(document: MemoryDocument): string {
  let highest = 0;
  for (const entry of memoryEntries(document)) {
    if (entry.id !== null) highest = Math.max(highest, Number(entry.id.slice(1)));
  }
  return `m${highest + 1}`;
}

// ── writing ────────────────────────────────────────────────────────────────────────────────────

function checkTask(task: string): void {
  if (!TASK_RE.test(task)) throw new MemoryError('invalid_task', `"${task}" is not a task id.`);
}

function checkTime(at: string): void {
  if (!TIME_RE.test(at)) {
    throw new MemoryError(
      'invalid_time',
      `"${at}" is not YYYY-MM-DD HH:mm; use formatLocalMinute.`,
    );
  }
}

function checkScope(repo: string): void {
  if (!REPO_RE.test(repo)) {
    throw new MemoryError('invalid_scope', `"${repo}" is not an "owner/name" repository.`);
  }
}

/** A hand-written bullet gets its id the first time anything is written (ADR-0021). */
export function numberLegacy(document: MemoryDocument): MemoryDocument {
  if (!memoryEntries(document).some((entry) => entry.id === null)) return document;
  let counter = Number(nextId(document).slice(1));
  return {
    ...document,
    lines: document.lines.map((line) =>
      line.kind === 'entry' && line.entry.id === null
        ? { kind: 'entry', entry: { ...line.entry, id: `m${counter++}` }, raw: null }
        : line,
    ),
  };
}

/** A section always ends in a newline once the engine has written to it. */
function finish(lines: readonly MemoryLine[]): MemoryLine[] {
  const last = lines[lines.length - 1];
  return last !== undefined && last.raw !== '' ? [...lines, { kind: 'text', raw: '' }] : [...lines];
}

function lastNonBlank(lines: readonly MemoryLine[], from: number, to: number): number {
  for (let i = to - 1; i > from; i--) {
    const line = lines[i];
    if (line !== undefined && (line.kind !== 'text' || line.raw.trim() !== '')) return i;
  }
  return from;
}

function insertEntry(
  document: MemoryDocument,
  entry: MemoryEntry,
): { document: MemoryDocument; id: string } {
  const lines = [...document.lines];
  const id = entry.id as string;
  const line: MemoryLine = { kind: 'entry', entry, raw: null };
  const firstScope = lines.findIndex((l) => l.kind === 'scope');

  let from = 0;
  let to = firstScope === -1 ? lines.length : firstScope;
  if (entry.scope !== null) {
    const heading = lines.findIndex((l) => l.kind === 'scope' && l.scope === entry.scope);
    if (heading === -1) {
      const pos = lastNonBlank(lines, 0, lines.length) + 1;
      lines.splice(
        pos,
        0,
        { kind: 'text', raw: '' },
        { kind: 'scope', raw: `### ${entry.scope}`, scope: entry.scope },
        { kind: 'text', raw: '' },
        line,
      );
      return { document: { present: true, lines: finish(lines) }, id };
    }
    from = heading;
    const next = lines.findIndex((l, i) => i > heading && l.kind === 'scope');
    to = next === -1 ? lines.length : next;
  }
  const pos = lastNonBlank(lines, from, to) + 1;
  // Directly under a heading, keep one blank line between it and the entry.
  const underHeading = pos - 1 === from;
  lines.splice(
    pos,
    0,
    ...(underHeading ? [{ kind: 'text', raw: '' } as MemoryLine, line] : [line]),
  );
  return { document: { present: true, lines: finish(lines) }, id };
}

export interface AddOwnerEntryInput {
  readonly fact: string;
  /** `owner/name`; omitted or null means the entry applies everywhere. */
  readonly repo?: string | null;
  /** Local time, `YYYY-MM-DD HH:mm`. */
  readonly at: string;
  /** The task the owner's words came up in, for `owner via T-n`. */
  readonly via?: string | null;
  /** Where the words came from, e.g. `message 0193…`. */
  readonly source?: string | null;
}

export function addOwnerEntry(
  document: MemoryDocument,
  input: AddOwnerEntryInput,
): { document: MemoryDocument; id: string } {
  const fact = sanitizeFact(input.fact);
  checkTime(input.at);
  const repo = input.repo ?? null;
  if (repo !== null) checkScope(repo);
  const via = input.via ?? null;
  if (via !== null) checkTask(via);
  const source = input.source ?? null;
  if (source !== null && /[\r\n]/.test(source)) {
    throw new MemoryError('invalid_citation', 'A source is one line.');
  }
  const numbered = numberLegacy(document);
  const id = nextId(numbered);
  return insertEntry(numbered, {
    id,
    origin: 'owner',
    scope: repo,
    fact,
    at: input.at,
    task: via,
    source,
    citations: [],
    confirmed: 0,
    contradicted: 0,
    last: null,
  });
}

export interface AddAgentEntryInput {
  readonly fact: string;
  /** An agent entry is always scoped to one repository (ADR-0021). */
  readonly repo: string;
  readonly citations: readonly string[];
  readonly task: string;
  readonly at: string;
}

export function addAgentEntry(
  document: MemoryDocument,
  input: AddAgentEntryInput,
): { document: MemoryDocument; id: string } {
  const fact = sanitizeFact(input.fact);
  checkTime(input.at);
  checkTask(input.task);
  checkScope(input.repo);
  for (const citation of input.citations) {
    if (citation === '' || /\s/.test(citation)) {
      throw new MemoryError('invalid_citation', `"${citation}" is not a usable citation.`);
    }
  }
  const numbered = numberLegacy(document);
  const id = nextId(numbered);
  return insertEntry(numbered, {
    id,
    origin: 'agent',
    scope: input.repo,
    fact,
    at: input.at,
    task: input.task,
    source: null,
    citations: [...input.citations],
    confirmed: 1,
    contradicted: 0,
    last: null,
  });
}

export interface CountResult {
  readonly document: MemoryDocument;
  /** False when nothing changed in the file: the entry belongs to the owner, who has no counters. */
  readonly changed: boolean;
  readonly entry: MemoryEntry;
}

function count(
  document: MemoryDocument,
  input: { id: string; task: string; at: string },
  field: 'confirmed' | 'contradicted',
): CountResult {
  checkTask(input.task);
  checkTime(input.at);
  const found = findEntry(document, input.id);
  if (found === undefined) throw new MemoryError('unknown_entry', `There is no entry ${input.id}.`);
  if (found.origin === 'owner') return { document, changed: false, entry: found };
  const updated: MemoryEntry = {
    ...found,
    [field]: found[field] + 1,
    last: { task: input.task, at: input.at },
  };
  const numbered = numberLegacy(document);
  return {
    document: {
      ...numbered,
      lines: finish(
        numbered.lines.map((line) =>
          line.kind === 'entry' && line.entry.id === input.id
            ? { kind: 'entry', entry: updated, raw: null }
            : line,
        ),
      ),
    },
    changed: true,
    entry: updated,
  };
}

/** ✓ +1 on an agent entry. On an owner entry nothing changes. The fact text is never touched. */
export function confirmEntry(
  document: MemoryDocument,
  input: { id: string; task: string; at: string },
): CountResult {
  return count(document, input, 'confirmed');
}

/** ✗ +1 on an agent entry. On an owner entry nothing changes. The fact text is never touched. */
export function contradictEntry(
  document: MemoryDocument,
  input: { id: string; task: string; at: string },
): CountResult {
  return count(document, input, 'contradicted');
}

export function forgetEntry(
  document: MemoryDocument,
  id: string,
): { document: MemoryDocument; removed: MemoryEntry } {
  const removed = findEntry(document, id);
  if (removed === undefined) throw new MemoryError('unknown_entry', `There is no entry ${id}.`);
  const numbered = numberLegacy(document);
  return {
    document: {
      ...numbered,
      lines: finish(
        numbered.lines.filter((line) => !(line.kind === 'entry' && line.entry.id === id)),
      ),
    },
    removed,
  };
}

const earlier = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a <= b ? a : b;

/**
 * Replaces several entries of one scope with a single entry carrying `fact`: counters summed, the
 * earliest creation kept, citations joined. If any merged entry is the owner's, the result is an
 * owner entry (the dispatcher acts for the owner). It takes the first entry's place in the file.
 */
export function mergeEntries(
  document: MemoryDocument,
  input: { ids: readonly string[]; fact: string },
): { document: MemoryDocument; id: string; removed: MemoryEntry[] } {
  const fact = sanitizeFact(input.fact);
  const ids = [...new Set(input.ids)];
  if (ids.length < 2)
    throw new MemoryError('too_few_entries', 'A merge needs two or more entries.');
  const entries = ids.map((id) => {
    const found = findEntry(document, id);
    if (found === undefined) throw new MemoryError('unknown_entry', `There is no entry ${id}.`);
    return found;
  });
  const scope = entries[0]?.scope ?? null;
  if (entries.some((entry) => entry.scope !== scope)) {
    throw new MemoryError('scope_mismatch', 'Entries from different scopes cannot be merged.');
  }

  const numbered = numberLegacy(document);
  const id = nextId(numbered);
  const at = entries.reduce<string | null>((acc, entry) => earlier(acc, entry.at), null);
  const oldest = entries.find((entry) => entry.at === at) ?? entries[0];
  const allAgent = entries.every((entry) => entry.origin === 'agent');
  const lasts = entries.flatMap((entry) => (entry.last === null ? [] : [entry.last]));
  const last = lasts.reduce<{ task: string; at: string } | null>(
    (acc, item) => (acc === null || item.at > acc.at ? item : acc),
    null,
  );
  const merged: MemoryEntry = allAgent
    ? {
        id,
        origin: 'agent',
        scope,
        fact,
        at,
        task: oldest?.task ?? null,
        source: null,
        citations: [...new Set(entries.flatMap((entry) => entry.citations))],
        confirmed: entries.reduce((sum, entry) => sum + entry.confirmed, 0),
        contradicted: entries.reduce((sum, entry) => sum + entry.contradicted, 0),
        last,
      }
    : {
        id,
        origin: 'owner',
        scope,
        fact,
        at,
        task: null,
        source: null,
        citations: [],
        confirmed: 0,
        contradicted: 0,
        last: null,
      };

  let placed = false;
  const lines: MemoryLine[] = [];
  for (const line of numbered.lines) {
    if (line.kind === 'entry' && line.entry.id !== null && ids.includes(line.entry.id)) {
      if (!placed) {
        lines.push({ kind: 'entry', entry: merged, raw: null });
        placed = true;
      }
      continue;
    }
    lines.push(line);
  }
  return { document: { ...numbered, lines: finish(lines) }, id, removed: entries };
}

// ── what a run sees ────────────────────────────────────────────────────────────────────────────

const recency = (entry: MemoryEntry): string => entry.last?.at ?? entry.at ?? '';

function compareAgent(a: MemoryEntry, b: MemoryEntry): number {
  if (a.confirmed !== b.confirmed) return b.confirmed - a.confirmed;
  const ra = recency(a);
  const rb = recency(b);
  return ra === rb ? 0 : ra < rb ? 1 : -1;
}

export interface WorkerSelection {
  readonly entries: readonly MemoryEntry[];
  /** True when the soft cap left something out of `entries`. */
  readonly cut: boolean;
}

/**
 * The entries a worker run on `repo` gets: unscoped ones and that repository's. Owner entries
 * first in file order, then agent entries by ✓ and recency, those with ✗ above ✓ last; taken in
 * that order until `softCapChars` (the size of the rendered lines) would be exceeded.
 */
export function selectForWorker(
  document: MemoryDocument,
  repo: string,
  softCapChars: number,
): WorkerSelection {
  const applicable = memoryEntries(document).filter(
    (entry) => entry.scope === null || entry.scope === repo,
  );
  const owner = applicable.filter((entry) => entry.origin === 'owner');
  const agent = applicable.filter((entry) => entry.origin === 'agent');
  const disputed = (entry: MemoryEntry): boolean => entry.contradicted > entry.confirmed;
  const ordered = [
    ...owner,
    ...agent.filter((entry) => !disputed(entry)).sort(compareAgent),
    ...agent.filter(disputed).sort(compareAgent),
  ];

  const taken: MemoryEntry[] = [];
  let size = 0;
  for (const entry of ordered) {
    size += renderEntry(entry).length + 1;
    if (size > softCapChars) return { entries: taken, cut: true };
    taken.push(entry);
  }
  return { entries: taken, cut: false };
}

/** What the dispatcher gets: the owner's entries of every scope, never an agent entry. */
export function selectForDispatcher(document: MemoryDocument): MemoryEntry[] {
  return memoryEntries(document).filter((entry) => entry.origin === 'owner');
}
