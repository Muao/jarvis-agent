import { describe, expect, it } from 'vitest';
import {
  EnvironmentPlanSchema,
  planCredentialViolations,
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
    ['an image by digest', { image: 'node@sha256:abc' }],
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

  it('refuses a credential written into a command', () => {
    const problems = planCredentialViolations(
      plan({ prepare: ['psql postgres://app:hunter2@db/app -c "select 1"'] }),
    );
    expect(problems[0]).toMatch(/^prepare\[0\]/);
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
