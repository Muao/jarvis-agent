import type { PermissionRequest } from '../../domain/index.js';
import type { Logger } from '../ports/logger.js';
import type { RunEventLog } from '../runs/run-event-log.js';

/** Shows the request and its outcome in the run's console (ADM-03). Best effort: the decision is already stored. */
export async function recordPermissionEvent(
  deps: { readonly eventLog: RunEventLog; readonly logger: Logger },
  request: PermissionRequest,
): Promise<void> {
  try {
    await deps.eventLog.append(request.runId, {
      kind: 'permission',
      payload: {
        permissionId: request.id,
        toolName: request.tool,
        decision: request.status,
      },
    });
  } catch (error) {
    deps.logger.warn('could not record a permission event', {
      permissionId: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
