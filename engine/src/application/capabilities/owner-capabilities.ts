import {
  CapabilityNameSchema,
  OwnerAgentInputSchema,
  OwnerSkillInputSchema,
  type CapabilityKind,
  type OwnerCapabilityDoc,
} from '@jarvis/shared';
import { InvalidInputError, NotFoundError } from '../errors.js';
import type {
  CapabilityCatalog,
  OwnerCapabilityInput,
  OwnerPluginStore,
} from '../ports/capabilities.js';

interface Deps {
  readonly catalog: CapabilityCatalog;
  readonly store: OwnerPluginStore;
}

const SINGULAR = { skills: 'skill', agents: 'subagent' } as const;

function checkName(name: string): void {
  const result = CapabilityNameSchema.safeParse(name);
  if (!result.success) {
    throw new InvalidInputError(`Invalid name: ${result.error.issues[0]?.message ?? 'rejected'}.`);
  }
}

/** `GET /api/capabilities/owner/{skills|agents}/:name`. */
export class GetOwnerCapability {
  constructor(private readonly deps: Deps) {}

  async execute(kind: CapabilityKind, name: string): Promise<OwnerCapabilityDoc> {
    checkName(name);
    const doc = await this.deps.store.get(kind, name);
    if (doc === null) throw new NotFoundError(SINGULAR[kind], name);
    return doc;
  }
}

/**
 * `PUT`: creates or replaces one of the owner's own skills or subagents (ADR-0025). The name may
 * not be a built-in's: two plugins defining the same name leave it to Claude Code which one a run
 * gets. Reachable only from the owner's HTTP API, never from an agent tool.
 */
export class SaveOwnerCapability {
  constructor(private readonly deps: Deps) {}

  async execute(
    kind: CapabilityKind,
    name: string,
    input: OwnerCapabilityInput,
  ): Promise<{ readonly created: boolean }> {
    checkName(name);
    const schema = kind === 'skills' ? OwnerSkillInputSchema : OwnerAgentInputSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new InvalidInputError(`${issue?.path.join('.') ?? 'input'}: ${issue?.message ?? ''}`);
    }
    const catalog = await this.deps.catalog.list();
    if (catalog[kind].some((item) => item.source === 'builtin' && item.name === name)) {
      throw new InvalidInputError(
        `"${name}" is a built-in ${SINGULAR[kind]}; pick another name so a run is never ambiguous about which one it gets.`,
      );
    }
    return this.deps.store.put(kind, name, parsed.data);
  }
}

/** `DELETE`: removes one of the owner's own items, after the store has backed it up. */
export class DeleteOwnerCapability {
  constructor(private readonly deps: Deps) {}

  async execute(kind: CapabilityKind, name: string): Promise<void> {
    checkName(name);
    if (!(await this.deps.store.delete(kind, name))) throw new NotFoundError(SINGULAR[kind], name);
  }
}
