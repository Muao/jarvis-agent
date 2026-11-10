import type { Capabilities } from '@jarvis/shared';
import type { CapabilityCatalog } from '../ports/capabilities.js';

/** `GET /api/capabilities`: skills, subagents and MCP servers from every source, read-only. */
export class ListCapabilities {
  constructor(private readonly deps: { readonly catalog: CapabilityCatalog }) {}

  execute(): Promise<Capabilities> {
    return this.deps.catalog.list();
  }
}
