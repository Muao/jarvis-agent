/**
 * A small, strict reader and writer for the YAML frontmatter of a skill or subagent file
 * (ADR-0025). No YAML dependency: the files only use `key: value` lines, so that is all it
 * understands — plus the shapes found in the wild (quoted values, `>`/`|` blocks, `[a, b]` and
 * `- a` lists), which it reads but never writes.
 */
export interface Frontmatter {
  readonly fields: Readonly<Record<string, string | string[]>>;
  readonly body: string;
}

const FENCE = /^---[ \t]*$/;

export function parseFrontmatter(text: string): Frontmatter | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] === undefined || !FENCE.test(lines[0])) return null;
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  if (end === -1) return null;

  const fields: Record<string, string | string[]> = {};
  let index = 1;
  while (index < end) {
    const line = lines[index] ?? '';
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    index += 1;
    if (match === null) continue;
    const key = match[1] as string;
    const value = (match[2] as string).trim();
    // Continuation lines: indented text or `- item` entries belong to this key.
    const continuation: string[] = [];
    while (index < end && /^([ \t]+\S|[ \t]*-[ \t])/.test(lines[index] ?? '')) {
      continuation.push((lines[index] as string).trim());
      index += 1;
    }
    if (/^[>|][+-]?$/.test(value)) {
      fields[key] = continuation.join(value.startsWith('>') ? ' ' : '\n');
    } else if (value === '' && continuation.every((item) => item.startsWith('- '))) {
      fields[key] = continuation.map((item) => unquote(item.slice(2).trim()));
    } else if (value.startsWith('[') && value.endsWith(']')) {
      fields[key] = splitList(value.slice(1, -1));
    } else {
      fields[key] = unquote(value);
    }
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not JSON-compatible: fall through and keep it as written.
    }
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '');
}

/** `tools: Read, Glob` (a comma list), a flow list or a block list, as a list of names. */
export function listField(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : splitList(value);
  return items.length === 0 ? undefined : items;
}

export function textField(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

export interface FrontmatterOutput {
  readonly name: string;
  readonly description: string;
  readonly tools?: readonly string[] | undefined;
  readonly model?: string | undefined;
  readonly body: string;
}

/**
 * The description goes out as a JSON string (a valid double-quoted YAML scalar), so a colon, a
 * quote or a leading `#` in it cannot change what the line means. `name` and `model` are validated
 * tokens and tools carry no commas, so they stay plain.
 */
export function serializeFrontmatter(doc: FrontmatterOutput): string {
  const lines = ['---', `name: ${doc.name}`, `description: ${JSON.stringify(doc.description)}`];
  if (doc.tools !== undefined && doc.tools.length > 0) lines.push(`tools: ${doc.tools.join(', ')}`);
  if (doc.model !== undefined) lines.push(`model: ${doc.model}`);
  lines.push('---', '');
  const body = doc.body.replace(/^\n+/, '');
  return `${lines.join('\n')}\n${body.endsWith('\n') || body === '' ? body : `${body}\n`}`;
}
