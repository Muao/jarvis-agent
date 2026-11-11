import { describe, expect, it } from 'vitest';
import {
  EnvironmentPlanSchema,
  planCredentialViolations,
  redactPlanForJournal,
  resolvePlanEnv,
  type EnvironmentPlanInput,
} from './environment-plan.js';

// Built at run time so no token-shaped literal sits in the repository.
const FAKE_TOKEN = `${'gh'}${'p_'}${'x'.repeat(30)}`;

const plan = (input: Partial<EnvironmentPlanInput> = {}) =>
  EnvironmentPlanSchema.parse({ app: { command: 'npm run dev', port: 5173 }, ...input });

describe('EnvironmentPlanSchema (ADR-0026)', () => {
  it('needs only the app and fills in the rest', () => {
    expect(plan()).toEqual({
      prepare: [],
      services: [],
      app: { command: 'npm run dev', port: 5173, readyPath: '/' },
      extraPorts: [],
      env: {},
    });
  });

  it('takes a full plan: image services, process services, generated secrets', () => {
    const full = plan({
      image: 'node:22-bookworm',
      prepare: ['npm --prefix server ci'],
      services: [
        { name: 'db', image: 'mongo:7', ready: { tcp: 27017 } },
        { name: 'api', command: 'node server.js', cwd: 'server', ready: { tcp: 5001 } },
      ],
      extraPorts: [5001],
      env: { JWT_SECRET: { generate: true }, NODE_ENV: 'development' },
    });
    expect(full.services).toHaveLength(2);
  });

  it.each([
    ['an image with flags', { image: 'node --privileged' }],
    ['an image by a short digest', { image: 'node@sha256:abc' }],
    ['an image on an arbitrary registry', { image: 'evil.example.com/team/app:1' }],
    ['an image on localhost', { image: 'localhost/app' }],
    ['an image on an IP registry', { image: '10.0.0.5/app:1' }],
    ['an image on a registry with a port', { image: 'registry.local:5000/app' }],
    ['an image on localhost with a port', { image: 'localhost:5000/app' }],
    ['an image on an unlisted ghcr look-alike', { image: 'ghcr.io.evil.com/a/b' }],
    ['a cwd that leaves the repository', { app: { command: 'x', port: 5173, cwd: '../..' } }],
    ['an absolute cwd', { app: { command: 'x', port: 5173, cwd: '/etc' } }],
    ['a privileged port', { app: { command: 'x', port: 80 } }],
    ['a service with neither image nor command', { services: [{ name: 'db' }] }],
    [
      'two services with one name',
      {
        services: [
          { name: 'a', command: 'x' },
          { name: 'a', command: 'y' },
        ],
      },
    ],
    ['an extra port equal to the app port', { extraPorts: [5173] }],
    ['a multi-line env value', { env: { A: 'one\ntwo' } }],
    ['an unknown key', { mounts: ['/:/host'] }],
  ])('refuses %s', (_name, input) => {
    expect(
      EnvironmentPlanSchema.safeParse({ app: { command: 'npm run dev', port: 5173 }, ...input })
        .success,
    ).toBe(false);
  });
});

describe('image references', () => {
  it.each([
    'node',
    'node:22-bookworm',
    'mongo:7',
    'bitnami/redis:7.2',
    'docker.io/library/postgres:16',
    'ghcr.io/org/image:tag',
    'mcr.microsoft.com/playwright:v1.50.0-noble',
    'public.ecr.aws/docker/library/redis:7',
    `node:22@sha256:${'a'.repeat(64)}`,
    `ghcr.io/org/image@sha256:${'0'.repeat(64)}`,
  ])('accepts %s', (image) => {
    expect(plan({ image }).image).toBe(image);
  });
});

describe('runAsRoot', () => {
  it('is optional and stays out of the plan when unset', () => {
    expect(plan().runAsRoot).toBeUndefined();
    expect(plan({ runAsRoot: true }).runAsRoot).toBe(true);
  });
});

describe('planCredentialViolations', () => {
  it('passes generated secrets and references to them', () => {
    expect(
      planCredentialViolations(
        plan({
          env: {
            DB_PASSWORD: { generate: true },
            JWT_SECRET: { generate: true },
            MONGO_INITDB_ROOT_PASSWORD: '${DB_PASSWORD}',
            MONGODB_URI: 'mongodb://app:${DB_PASSWORD}@db:27017/app',
            NODE_ENV: 'development',
            PORT: '5001',
          },
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a literal value under a secret name', { JWT_SECRET: 'dev-secret' }, /env\.JWT_SECRET/],
    [
      'a password inside a URL',
      { DATABASE_URL: 'postgres://app:hunter2@db/app' },
      /literal password/,
    ],
    ['a token by its shape', { NOTE: FAKE_TOKEN }, /real credential/],
    ['a reference to nothing', { API_URL: 'http://${HOST}:1' }, /does not define/],
    ['a secret name pointing at a plain value', { A: 'x', API_KEY: '${A}' }, /env\.API_KEY/],
  ])('refuses %s', (_name, env, message) => {
    const problems = planCredentialViolations(plan({ env }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
  });

  it.each([
    ['a passphrase-like name', { SESSION_PASS: 'correct-horse' }],
    ['a pwd name', { MYSQL_PWD: 'rootroot' }],
    ['an auth name', { BASIC_AUTH: 'admin:admin' }],
    ['a salt name', { PASSWORD_SALT: 'pepper1' }],
    ['a cookie name', { COOKIE_SIGNING: 'abc' }],
    ['a private name', { PRIVATE_THING: 'abc' }],
    ['a _KEY suffix', { STRIPE_KEY: 'abc' }],
  ])('refuses %s with a literal value', (_name, env) => {
    expect(planCredentialViolations(plan({ env }))).toHaveLength(1);
  });

  it('lets harmless values through under a secret-looking name', () => {
    expect(
      planCredentialViolations(
        plan({
          env: {
            AUTH_ENABLED: 'true',
            AUTH_URL: 'http://localhost:3000/auth',
            PASSWORD_MIN_LENGTH: '8',
            KEY: '',
          },
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a long random-looking value under an innocent name', () => {
    const problems = planCredentialViolations(
      plan({ env: { SOMETHING: 'Zk9vQ2x7LmR4pT8wYb3NcE6hJd1sFa5U' } }),
    );
    expect(problems[0]).toMatch(/random-looking/);
  });

  it('does not take paths, URLs, prose or short values for secrets', () => {
    expect(
      planCredentialViolations(
        plan({
          env: {
            PATH_X: '/usr/local/lib/node_modules/some-package/bin/cli-1.2.3',
            API_URL: 'https://api.example.com/v1/things?limit=100',
            GREETING: 'hello there this is a sentence with 3 numbers',
            NODE_OPTIONS: '--max-old-space-size=2048',
            SHORT: 'a1b2c3',
          },
        }),
      ),
    ).toEqual([]);
  });

  it('accepts what the engine generates itself: hex placeholders never appear as plan strings', () => {
    expect(
      planCredentialViolations(
        plan({
          env: {
            SECRET_KEY_BASE: { generate: true },
            DB_URL: 'postgres://app:${SECRET_KEY_BASE}@db/x',
          },
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['--password with a value', 'mysql --password hunter2 -e "select 1"'],
    ['--password=value', 'mysql --password=hunter2'],
    ['--token=value', 'tool login --token=abc123def'],
    ['an inline PGPASSWORD', 'PGPASSWORD=hunter2 psql -h db -c "select 1"'],
    ['an inline MYSQL_PWD after &&', 'cd x && MYSQL_PWD=rootroot mysql -h db'],
  ])('refuses %s in a command', (_name, command) => {
    const problems = planCredentialViolations(plan({ prepare: [command] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^prepare\[0\]/);
  });

  it.each([
    'mysql --password "$DB_PASSWORD"',
    'PGPASSWORD=$DB_PASSWORD psql -h db',
    'PGPASSWORD="${DB_PASSWORD}" psql -h db',
    'npm ci --no-audit && NODE_ENV=test npm run build',
    'git config user.email a@b.c --global',
  ])('lets %s through', (command) => {
    expect(planCredentialViolations(plan({ prepare: [command] }))).toEqual([]);
  });

  it('refuses a credential written into a command', () => {
    const problems = planCredentialViolations(
      plan({ prepare: ['psql postgres://app:hunter2@db/app -c "select 1"'] }),
    );
    expect(problems[0]).toMatch(/^prepare\[0\]/);
  });
});

describe('redactPlanForJournal', () => {
  it('keeps env names and drops every value', () => {
    const redacted = redactPlanForJournal(
      plan({ env: { NODE_ENV: 'development', DB_PASSWORD: { generate: true } } }),
    );
    expect(redacted.env).toEqual({ NODE_ENV: 'set', DB_PASSWORD: 'generated' });
    expect(JSON.stringify(redacted)).not.toContain('development');
  });
});

describe('resolvePlanEnv', () => {
  it('generates each secret once and fills references in', () => {
    let n = 0;
    const env = resolvePlanEnv(
      plan({
        env: {
          DB_PASSWORD: { generate: true },
          URL: 'mongodb://app:${DB_PASSWORD}@db/app',
          COPY: '${URL}',
          PLAIN: 'x',
        },
      }),
      () => `secret${++n}`,
    );
    expect(env).toEqual({
      DB_PASSWORD: 'secret1',
      URL: 'mongodb://app:secret1@db/app',
      COPY: 'mongodb://app:secret1@db/app',
      PLAIN: 'x',
    });
  });
});
