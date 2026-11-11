import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentPlanSchema, JarvisConfigSchema } from '@jarvis/shared';
import { afterAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../application/index.js';
import { DockerDevServer } from './docker-dev-server.js';

/**
 * Opt-in: `JARVIS_DOCKER_TEST=1 pnpm --filter @jarvis/engine exec vitest run <this file>` against
 * the local Docker daemon. Proves the hardened flags (non-root, cap-drop, limits) still bring up a
 * Node app next to a Postgres service. Pulls node:22-bookworm and postgres:16-alpine.
 */
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const enabled = process.env['JARVIS_DOCKER_TEST'] === '1';

describe.skipIf(!enabled)('DockerDevServer against a real daemon', () => {
  const server = new DockerDevServer({
    ui: () =>
      JarvisConfigSchema.parse({
        repo: { path: '/repo' },
        ui: { enabled: true, readyTimeoutSeconds: 60 },
      }).ui,
    logger,
    env: process.env,
  });
  afterAll(async () => {
    await server.stopAll();
  });

  it('starts a node app and a postgres service under the hardened flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-docker-test-'));
    try {
      await writeFile(
        join(dir, 'server.js'),
        "require('http').createServer((q,r)=>r.end(process.getuid()+' '+require('fs').existsSync('built.txt'))).listen(3000,'0.0.0.0')",
      );
      const plan = EnvironmentPlanSchema.parse({
        prepare: ["node -e \"require('fs').writeFileSync('built.txt','ok')\""],
        services: [{ name: 'db', image: 'postgres:16-alpine', ready: { tcp: 5432 } }],
        app: { command: 'node server.js', port: 3000 },
        env: { POSTGRES_PASSWORD: { generate: true } },
      });

      const result = await server.start('DOCKER-TEST', dir, plan);

      expect(result).toMatchObject({ ok: true });
      const body = await (await fetch('http://127.0.0.1:3000/')).text();
      expect(body).toBe('1000 true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
