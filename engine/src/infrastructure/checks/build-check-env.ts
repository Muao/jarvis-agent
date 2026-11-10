/**
 * The only variables a check command inherits from the engine (ADR-0022), plus `CI=true`.
 *
 * The same rule as the dev server's (`dev-server-env.ts`): the commands are the repository's own,
 * and what they run — a test suite, a `postinstall` — may be code nobody here wrote. So no
 * `GITHUB_TOKEN`, `DATABASE_URL`, `INFISICAL_*` or `CLAUDE_CONFIG_DIR` is handed over, and no
 * variable is added because it "might" be needed: a project that needs one fails in its own
 * message and the owner declares it deliberately.
 */
const INHERITED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'USER'] as const;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function buildCheckEnv(source: EnvSource): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env['CI'] = 'true';
  return env;
}
