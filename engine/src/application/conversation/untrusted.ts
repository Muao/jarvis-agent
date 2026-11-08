/**
 * SEC-03 / ADR-0017: externally-authored text the engine places into a prompt is wrapped as data,
 * so the model sees an unambiguous marker between "what the outside author wrote" and "what the
 * engine asks". The body is defused first: a quoted `<untrusted-content>` or `</untrusted-content>`
 * inside it is rewritten so the quoted text cannot close the wrapper and smuggle the rest of itself
 * outside the tag.
 */
export function untrustedContent(input: {
  /** Where the text came from, e.g. `pr-comment`. */
  readonly source: string;
  /** The external author, when known. */
  readonly author?: string;
  readonly body: string;
}): string {
  const safe = input.body.replace(/<(\/?)\s*untrusted-content/gi, '[$1untrusted-content');
  const author = input.author === undefined ? '' : ` author="${input.author.replaceAll('"', "'")}"`;
  return [
    `<untrusted-content source="${input.source}"${author}>`,
    safe.trim(),
    '</untrusted-content>',
  ].join('\n');
}
