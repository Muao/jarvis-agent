import type {
  Capabilities,
  CapabilityItem,
  CapabilityKind,
  OwnerAgentInput,
  OwnerCapabilityDoc,
} from '@jarvis/shared';
import type {
  CapabilityCatalog,
  OwnerCapabilityInput,
  OwnerPluginStore,
} from '../ports/capabilities.js';

/** An in-memory owner plugin: what the owner saved, keyed `kind/name`. */
export class FakeOwnerPluginStore implements OwnerPluginStore {
  readonly docs = new Map<string, OwnerCapabilityDoc>();
  readonly deleted: string[] = [];

  async get(kind: CapabilityKind, name: string): Promise<OwnerCapabilityDoc | null> {
    return this.docs.get(`${kind}/${name}`) ?? null;
  }

  async put(
    kind: CapabilityKind,
    name: string,
    input: OwnerCapabilityInput,
  ): Promise<{ created: boolean }> {
    const key = `${kind}/${name}`;
    const created = !this.docs.has(key);
    const agent = input as OwnerAgentInput;
    this.docs.set(key, {
      name,
      description: input.description,
      body: input.body,
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.tools === undefined ? {} : { tools: agent.tools }),
      markdown: `${name}: ${input.description}\n${input.body}`,
    });
    return { created };
  }

  async delete(kind: CapabilityKind, name: string): Promise<boolean> {
    this.deleted.push(`${kind}/${name}`);
    return this.docs.delete(`${kind}/${name}`);
  }
}

/** A catalog with built-ins you set plus whatever the fake store holds as the owner's. */
export class FakeCapabilityCatalog implements CapabilityCatalog {
  builtin: Capabilities = {
    skills: [{ name: 'sdd-flow', description: 'Artifacts', source: 'builtin', editable: false }],
    agents: [{ name: 'reviewer', description: 'Reviews', source: 'builtin', editable: false }],
    mcpServers: [],
  };

  constructor(private readonly store: FakeOwnerPluginStore) {}

  async list(): Promise<Capabilities> {
    const owned = (kind: CapabilityKind): CapabilityItem[] =>
      [...this.store.docs.entries()]
        .filter(([key]) => key.startsWith(`${kind}/`))
        .map(([, doc]) => ({
          name: doc.name,
          description: doc.description,
          source: 'owner' as const,
          editable: true,
        }));
    return {
      skills: [...this.builtin.skills, ...owned('skills')],
      agents: [...this.builtin.agents, ...owned('agents')],
      mcpServers: this.builtin.mcpServers,
    };
  }
}
