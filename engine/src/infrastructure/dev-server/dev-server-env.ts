import type { JarvisConfig } from '@jarvis/shared';

/**
 * The only variables the dev server inherits from the engine.
 *
 * ADR-0018's approval card decides whether a pull request's code may run; it never promised what
 * that code would find around it. Until this list existed the answer was "everything the engine
 * has" — `GITHUB_TOKEN`, `DATABASE_URL`, `INFISICAL_*` — handed to a `ui.devCommand` that usually
 * opens with `npm ci`, which runs the head's own `postinstall` scripts. Sourcing those secrets
 * properly through Infisical (ADR-0015) never helped at that last hop: where a secret comes from
 * and who receives it are different questions.
 *
 * Only what a build and a dev server genuinely need is here. Anything else the project needs is
 * declared by the owner in `ui.env`, which is a deliberate act rather than an accident of scope.
 */
const INHERITED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'USER'] as const;

/** `${NAME}` in a declared value, so a credential can be passed on purpose without being written to the config file (ADR-0015). */
const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * The environment for one `ui.devCommand`: the short inherited list plus the owner's declared
 * `ui.env`. A declared value of exactly `${NAME}` is replaced with that variable from the engine's
 * environment — the escape hatch for a project that truly needs a credential, kept explicit so it
 * shows up in the config instead of arriving silently. An unset reference becomes an empty string,
 * exactly as the connector substitution does, so a missing variable fails in the project's own
 * error message rather than as a shell parse error.
 */
export function buildDevServerEnv(source: EnvSource, ui: JarvisConfig['ui']): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, declared] of Object.entries(ui.env)) {
    const reference = REFERENCE.exec(declared);
    env[name] = reference === null ? declared : (source[reference[1] ?? ''] ?? '');
  }
  return env;
}
