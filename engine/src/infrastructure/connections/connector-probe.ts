import type { Probe } from './probe.js';

export interface ConnectorState {
  /** What is missing, in words ("NOTION_TOKEN", "connectors.notionRoot"). Empty when configured. */
  readonly missing: readonly string[];
  readonly details: readonly { readonly label: string; readonly value: string }[];
}

/**
 * Notion and Google Docs are reached by the worker's MCP servers, so the engine cannot test them
 * without a model run. The probe reports whether the pieces it can see are configured; the
 * owner learns about a bad link when a worker reads it.
 */
export function connectorProbe(state: () => ConnectorState): Probe {
  return async () => {
    const { missing, details } = state();
    if (missing.length > 0) {
      return {
        status: 'not_configured',
        summary: `Not configured: ${missing.join(', ')}.`,
        details: [],
      };
    }
    return {
      status: 'ok',
      summary: 'Configured. Access is checked when a worker reads it.',
      details,
    };
  };
}

/** A connection with no probe in this iteration. */
export function fixedProbe(status: 'not_configured' | 'disabled', summary: string): Probe {
  return async () => ({ status, summary, details: [] });
}
