import type { PermissionRequest } from '../../domain/index.js';

export interface PermissionRepository {
  get(id: string): Promise<PermissionRequest | null>;
  save(request: PermissionRequest): Promise<void>;
  /** Requests nobody answered yet, oldest first. */
  listPending(): Promise<readonly PermissionRequest[]>;
}
