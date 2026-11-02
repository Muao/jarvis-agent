const MASK = '[redacted]';

/** Token shapes masked even when the value is not a known secret (SEC-04). */
const TOKEN_SHAPES = [
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{10,}/g,
  /xox[abp]-[A-Za-z0-9-]{10,}/g,
];

/** Replaces every non-empty secret (raw and URL-encoded) and known token shapes with `[redacted]`. */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    values.add(encodeURIComponent(secret));
  }
  // Longest first so a secret containing another is masked whole.
  const ordered = [...values].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const value of ordered) out = out.split(value).join(MASK);
    for (const shape of TOKEN_SHAPES) out = out.replace(shape, MASK);
    return out;
  };
}
