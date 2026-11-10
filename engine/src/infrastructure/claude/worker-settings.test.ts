import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const file = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../agent/settings/worker.json',
);
const { permissions } = JSON.parse(readFileSync(file, 'utf8')) as {
  permissions: { allow: string[]; deny: string[] };
};

// ADR-0022: the worker cannot push or reach GitHub; the engine does. The deny rules are defence in
// depth, not the boundary (the boundary is the missing token).
describe('agent/settings/worker.json', () => {
  it('allows exactly the local tools and read-only/commit git', () => {
    expect(permissions.allow).toEqual([
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Bash',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git add:*)',
      'Bash(git commit:*)',
    ]);
  });

  it('denies every push and every gh command, and the secrets file', () => {
    expect(permissions.deny).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Bash(gh:*)', 'Read(~/.jarvis/.env)']),
    );
    expect(permissions.deny.filter((r) => /git push|gh /.test(r))).toEqual(['Bash(git push:*)']);
  });

  it('keeps the other destructive-command denies', () => {
    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(git branch -D:*)',
        'Bash(rm -rf:*)',
        'Bash(git reset --hard:*)',
        'Bash(git clean:*)',
        'Bash(git checkout main:*)',
        'Bash(sudo:*)',
      ]),
    );
  });
});
