import type { ApproveResult } from '@jarvis/shared';
import type { PermissionRequest } from '../../domain/index.js';

/** What the CLI's permission prompt tool gets back: `allow` returns the original input unchanged. */
export function toApproveResult(request: PermissionRequest): ApproveResult {
  switch (request.status) {
    case 'allow':
      return { behavior: 'allow', updatedInput: { ...request.input } };
    case 'timeout':
      return { behavior: 'deny', message: 'The owner did not answer in time, so this was denied.' };
    case 'deny':
    case 'pending':
      return { behavior: 'deny', message: 'The owner denied this request.' };
  }
}
