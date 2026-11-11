/**
 * Which changed files count as UI, by the globs of `ui.paths`. Only the three forms those globs
 * use are understood: `**` (any directories), `*` (anything but a slash) and `?` (one character).
 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$+.()|[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** The files of `changed` that match at least one glob, in their original order. */
export function uiFilesIn(changed: readonly string[], globs: readonly string[]): string[] {
  const patterns = globs.map(globToRegExp);
  return changed.filter((path) => patterns.some((pattern) => pattern.test(path)));
}
