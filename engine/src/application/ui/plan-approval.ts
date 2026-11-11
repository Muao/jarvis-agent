import { createHash } from 'node:crypto';
import type { EnvironmentPlan } from '@jarvis/shared';

/** Keys sorted at every level, so two equal plans serialise to the same text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/**
 * ADR-0018: what the owner approves is one plan on one head commit. The fingerprint of both goes
 * into the journal with the approval; a later plan, or a later head, hashes differently and asks
 * again. Everything of the plan is in it — env values too — but only the hash is stored.
 */
export function approvalFingerprint(plan: EnvironmentPlan, headSha: string): string {
  const text = JSON.stringify(canonical({ headSha, plan }));
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The plan as the owner sees it on the card: every image, every command of every step, ports, and
 * the NAMES of the variables — never their values.
 */
export function planForApproval(plan: EnvironmentPlan, defaultImage: string) {
  return {
    appImage: plan.image ?? defaultImage,
    runAsRoot: plan.runAsRoot === true,
    prepare: plan.prepare,
    services: plan.services.map((service) => ({
      name: service.name,
      image: service.image ?? null,
      command: service.command ?? null,
      cwd: service.cwd ?? null,
      readyTcp: service.ready?.tcp ?? null,
    })),
    app: {
      command: plan.app.command,
      cwd: plan.app.cwd ?? null,
      port: plan.app.port,
      readyPath: plan.app.readyPath,
    },
    extraPorts: plan.extraPorts,
    envNames: Object.keys(plan.env),
  };
}
