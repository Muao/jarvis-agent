import type {
  Capabilities,
  CapabilityKind,
  OwnerAgentInput,
  OwnerCapabilityDoc,
  OwnerSkillInput,
} from '@jarvis/shared';

/** Read side (ADR-0025): every skill, subagent and MCP server a run can use, whatever the source. */
export interface CapabilityCatalog {
  list(): Promise<Capabilities>;
}

/** What the owner may write: a skill has no model or tools. */
export type OwnerCapabilityInput = OwnerSkillInput | OwnerAgentInput;

/**
 * Write side (ADR-0025): the owner's own plugin. Only the HTTP use cases hold this port; it is
 * deliberately not reachable from any MCP tool.
 */
export interface OwnerPluginStore {
  get(kind: CapabilityKind, name: string): Promise<OwnerCapabilityDoc | null>;
  /** Creates or replaces; backs up the previous file first. Returns whether it was new. */
  put(
    kind: CapabilityKind,
    name: string,
    input: OwnerCapabilityInput,
  ): Promise<{ readonly created: boolean }>;
  /** Backs the file up, then removes it. False when there was nothing to delete. */
  delete(kind: CapabilityKind, name: string): Promise<boolean>;
}
