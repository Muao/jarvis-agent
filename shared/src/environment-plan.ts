import { z } from 'zod';

/**
 * ADR-0026: how to bring one target project up for a UI check. The worker composes it at runtime
 * from the repository's own files and passes it to `start_dev_server`; the engine runs it inside
 * disposable containers. Nothing here is configured by the owner, and nothing here may carry a
 * literal credential — a secret is `{ "generate": true }` and the engine invents it per check. The
 * credential check is a heuristic (see `planCredentialViolations`), so what is journalled of a plan
 * is `redactPlanForJournal`, never the raw plan.
 */

const port = z.number().int().min(1024).max(65535);

/**
 * Registries a plan may pull from besides Docker Hub (the implicit default). A plan is composed by
 * an agent reading an untrusted pull request, so an arbitrary registry — an IP, `localhost`, a
 * `host:port` — would let it pull from a server the pull request's author runs. ghcr.io and Docker
 * Hub host the images projects actually use; `mcr.microsoft.com` (Playwright, .NET, SQL Server)
 * and `public.ecr.aws` (mirrors of official images) are the other two common public ones.
 */
const REGISTRIES = ['docker.io', 'ghcr.io', 'mcr.microsoft.com', 'public.ecr.aws'] as const;

const IMAGE_NAME_PART = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE_REFERENCE = new RegExp(
  `^(?:(${REGISTRIES.map((r) => r.replace(/\./g, '\\.')).join('|')})/)?` +
    `(${IMAGE_NAME_PART}(?:/${IMAGE_NAME_PART})*)` +
    '(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$',
);

/**
 * A public image reference: `node:22-bookworm`, `mongo:7`, `ghcr.io/org/image:tag`, optionally
 * pinned `@sha256:<64 hex>`. No flags, and no registry outside `REGISTRIES`.
 */
const image = z
  .string()
  .max(200)
  .superRefine((value, ctx) => {
    const match = IMAGE_REFERENCE.exec(value);
    if (match === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a plain image reference such as node:22-bookworm',
      });
      return;
    }
    const [, registry, name = ''] = match;
    const first = name.split('/')[0] ?? '';
    // Without a listed registry the first component of `a/b` is a Docker Hub user: a dot in it,
    // or `localhost`, is how Docker itself recognises a registry host.
    if (
      registry === undefined &&
      name.includes('/') &&
      (first.includes('.') || first === 'localhost')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `registry "${first}" is not allowed; use Docker Hub, ghcr.io, mcr.microsoft.com or public.ecr.aws`,
      });
    }
  });

const command = z.string().min(1).max(2000);

/** A directory inside the repository, relative to its root. */
const cwd = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'must be a path inside the repository, relative to its root',
  });

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');

/** A literal value, possibly referring to other variables as `${NAME}`, or a per-check secret. */
export const EnvironmentValueSchema = z.union([
  z
    .string()
    .max(2000)
    .refine((value) => !/[\r\n]/.test(value), { message: 'must be one line' }),
  z.strictObject({
    generate: z.literal(true),
    /**
     * True hands the generated value back to the worker with the lease — for a login the browser
     * must type (a seeded admin's password). It is worth nothing once the check's containers are
     * gone, and it is kept out of the task journal and the plan that gets stored.
     */
    reveal: z.boolean().optional(),
  }),
]);
export type EnvironmentValue = z.infer<typeof EnvironmentValueSchema>;

export const EnvironmentServiceSchema = z.strictObject({
  /** Also the host name other containers reach an `image` service by. */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'must be a short lowercase name'),
  /**
   * Set: the service is its own container from this public image (a database, a cache), reachable
   * by `name`. Unset: `command` runs as a background process next to the app, in the app's
   * container, reachable on 127.0.0.1.
   */
  image: image.optional(),
  /** Required without `image`; with `image` it replaces the image's default command. */
  command: command.optional(),
  cwd: cwd.optional(),
  /** The engine waits until this TCP port accepts a connection before the next step. */
  ready: z.strictObject({ tcp: z.number().int().min(1).max(65535) }).optional(),
});
export type EnvironmentService = z.infer<typeof EnvironmentServiceSchema>;

export const EnvironmentPlanSchema = z
  .strictObject({
    /** The image the project's own commands run in. Default: `ui.defaultImage`. */
    image: image.optional(),
    /**
     * Opt-in: run `prepare` and the app as root in the app container. Without it they run as an
     * unprivileged user. Needed only when an install really has to write outside the workspace
     * (apt-get, global npm); the owner sees it on the approval card.
     */
    runAsRoot: z.boolean().optional(),
    /** Run once, in order, in the repository root before anything starts: installs and builds. */
    prepare: z.array(command).max(10).default([]),
    services: z.array(EnvironmentServiceSchema).max(6).default([]),
    /** The thing the browser opens. It must listen on 0.0.0.0, not on localhost. */
    app: z.strictObject({
      command,
      cwd: cwd.optional(),
      port,
      readyPath: z.string().startsWith('/').max(300).default('/'),
    }),
    /** Other ports of the app's container the browser must reach — an API on its own port. */
    extraPorts: z.array(port).max(6).default([]),
    env: z.record(envName, EnvironmentValueSchema).default({}),
  })
  .superRefine((plan, ctx) => {
    const names = new Set<string>();
    plan.services.forEach((service, index) => {
      if (names.has(service.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'name'],
          message: `duplicate service name "${service.name}"`,
        });
      }
      names.add(service.name);
      if (service.image === undefined && service.command === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index],
          message: 'a service needs an image, a command, or both',
        });
      }
      if (service.image !== undefined && service.cwd !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'cwd'],
          message: 'cwd applies only to a service that runs in the app container (no image)',
        });
      }
    });
    if (new Set([plan.app.port, ...plan.extraPorts]).size !== plan.extraPorts.length + 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['extraPorts'],
        message: 'extraPorts must be distinct and must not repeat app.port',
      });
    }
  });

export type EnvironmentPlan = z.output<typeof EnvironmentPlanSchema>;
export type EnvironmentPlanInput = z.input<typeof EnvironmentPlanSchema>;

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** A variable whose name says it holds a credential. */
const SECRET_NAME =
  /(SECRET|PASS|PWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|AUTH|SALT|COOKIE|SIGNING|ENCRYPTION|(^|_)KEY$|^KEY(_|$))/i;

/** Shapes of real credentials, wherever they appear. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_(?:pat)_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

/** `scheme://user:password@host` where the password is written out rather than `${NAME}`. */
const URL_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:([^\s/@]+)@/gi;

/** `--password hunter2`, `--token=abc`: a secret flag with a written-out value (not `$VAR`). */
const SECRET_FLAG =
  /(?:^|\s)--?(?:password|passwd|pass|pwd|token|secret|api-?key|auth-?token|access-?key|secret-?key)(?:=|\s+)(?!["']?\$)["']?[^\s"']+/i;

/** `PGPASSWORD=hunter2 psql …`: an inline assignment of a secret-named variable to a literal. */
const SECRET_ASSIGNMENT = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(["']?)(?!\$)([^\s"';&|)]+)\2/g;

/** Values that name a secret-looking variable but carry nothing secret. */
const HARMLESS_VALUE = /^(?:true|false|yes|no|on|off|none|null|[0-9]+|https?:\/\/[^\s@]*)$/i;

const MIN_RANDOM_LENGTH = 20;
const MIN_RANDOM_ENTROPY = 3.5;

/** Shannon entropy of `text` in bits per character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A long single-token value that looks random: a key someone pasted whatever its variable is
 * called. Paths, URLs and prose are left alone.
 */
function looksRandom(value: string): boolean {
  const bare = value.replace(REFERENCE, '');
  if (bare.length < MIN_RANDOM_LENGTH || /\s/.test(bare)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bare) || bare.startsWith('/') || /^[.-]/.test(bare)) {
    return false;
  }
  if (!/[0-9]/.test(bare) || !/[A-Za-z]/.test(bare)) return false;
  return entropy(bare) >= MIN_RANDOM_ENTROPY;
}

const isOnlyReferences = (value: string): boolean =>
  value.replace(REFERENCE, '').trim().length === 0;

function literalSecretIn(text: string): string | null {
  for (const shape of SECRET_SHAPES) {
    if (shape.test(text)) return 'it contains what looks like a real credential';
  }
  for (const match of text.matchAll(URL_PASSWORD)) {
    if (!isOnlyReferences(match[1] ?? '')) return 'it contains a URL with a literal password';
  }
  return null;
}

function literalSecretInCommand(text: string): string | null {
  const common = literalSecretIn(text);
  if (common !== null) return common;
  if (SECRET_FLAG.test(text)) return 'it passes a secret as a literal command-line argument';
  for (const match of text.matchAll(SECRET_ASSIGNMENT)) {
    if (SECRET_NAME.test(match[1] ?? '') && !HARMLESS_VALUE.test(match[3] ?? '')) {
      return `it assigns a literal value to ${match[1] ?? 'a secret variable'}`;
    }
  }
  return null;
}

/**
 * The credential rule of ADR-0026: no literal credential anywhere in a plan. This is a heuristic —
 * variable names, known token shapes, URL passwords, secret flags and inline assignments in
 * commands, long random-looking values — and it cannot prove a plan clean, so it is a guard
 * against mistakes, not the only protection: the journal gets `redactPlanForJournal`, never env
 * values. Returns one line per violation, each naming what to change; an empty list means the
 * plan may run.
 */
export function planCredentialViolations(plan: EnvironmentPlan): string[] {
  const problems: string[] = [];
  const names = new Set(Object.keys(plan.env));
  const generated = new Set(
    Object.entries(plan.env)
      .filter(([, value]) => typeof value !== 'string')
      .map(([name]) => name),
  );

  for (const [name, value] of Object.entries(plan.env)) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(REFERENCE)) {
      const referenced = match[1] ?? '';
      if (!names.has(referenced)) {
        problems.push(`env.${name} refers to \${${referenced}}, which the plan does not define`);
      } else if (referenced === name) {
        problems.push(`env.${name} refers to itself`);
      }
    }
    const secretName = SECRET_NAME.test(name);
    const refersToGenerated = [...value.matchAll(REFERENCE)].some((m) => generated.has(m[1] ?? ''));
    const harmless = value === '' || HARMLESS_VALUE.test(value);
    if (secretName && !harmless && !(isOnlyReferences(value) && refersToGenerated)) {
      problems.push(
        `env.${name} looks like a credential with a literal value: declare it as {"generate": true}`,
      );
      continue;
    }
    const why =
      literalSecretIn(value) ??
      (looksRandom(value) ? 'it holds a long random-looking value' : null);
    if (why !== null) {
      problems.push(
        `env.${name}: ${why}; generate the secret ({"generate": true}) and refer to it as \${NAME}`,
      );
    }
  }

  const commands: [string, string | undefined][] = [
    ...plan.prepare.map((value, i): [string, string] => [`prepare[${i}]`, value]),
    ...plan.services.map((s): [string, string | undefined] => [
      `services.${s.name}.command`,
      s.command,
    ]),
    ['app.command', plan.app.command],
  ];
  for (const [where, value] of commands) {
    if (value === undefined) continue;
    const why = literalSecretInCommand(value);
    if (why !== null) {
      problems.push(`${where}: ${why}; pass it through env as a generated value instead`);
    }
  }
  return problems;
}

/**
 * What may be written to the task journal of a plan: everything but the env values. A name is
 * kept (with `generated` or `set`), a value never is — the credential check is only a heuristic.
 */
export function redactPlanForJournal(plan: EnvironmentPlan): Omit<EnvironmentPlan, 'env'> & {
  env: Record<string, 'generated' | 'set'>;
} {
  const env: Record<string, 'generated' | 'set'> = {};
  for (const [name, value] of Object.entries(plan.env)) {
    env[name] = typeof value === 'string' ? 'set' : 'generated';
  }
  return { ...plan, env };
}

/** The generated variables the plan asked to see: `{ "generate": true, "reveal": true }`. */
export function revealedPlanEnv(
  plan: EnvironmentPlan,
  resolved: Readonly<Record<string, string>>,
): Record<string, string> {
  const revealed: Record<string, string> = {};
  for (const [name, value] of Object.entries(plan.env)) {
    if (typeof value !== 'string' && value.reveal === true) revealed[name] = resolved[name] ?? '';
  }
  return revealed;
}

/**
 * The environment the containers get: every `{ "generate": true }` replaced by `generate()`, then
 * `${NAME}` references filled in. References are resolved to a fixed depth, which is enough for a
 * connection string that names a generated password and cannot loop.
 */
export function resolvePlanEnv(
  plan: EnvironmentPlan,
  generate: () => string,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(plan.env)) {
    values[name] = typeof value === 'string' ? value : generate();
  }
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [name, value] of Object.entries(values)) {
      if (typeof plan.env[name] !== 'string') continue;
      values[name] = value.replace(REFERENCE, (whole, ref: string) =>
        ref !== name && ref in values ? (values[ref] ?? '') : whole,
      );
    }
  }
  return values;
}
