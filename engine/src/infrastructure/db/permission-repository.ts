import { asc, eq } from 'drizzle-orm';
import type { PermissionRepository } from '../../application/ports/permission-repository.js';
import type { PermissionRequest, PermissionStatus } from '../../domain/index.js';
import type { Executor } from './client.js';
import { permissionRequests } from './schema.js';
import { toDate, toDateOrNull, toIso, toIsoOrNull } from './time.js';

type Row = typeof permissionRequests.$inferSelect;

const toDomain = (row: Row): PermissionRequest => ({
  id: row.id,
  runId: row.runId,
  threadId: row.threadId,
  taskId: row.taskId,
  tool: row.tool,
  description: row.description,
  input: row.input,
  status: row.status as PermissionStatus,
  requestedAt: toIso(row.requestedAt),
  expiresAt: toIso(row.expiresAt),
  decidedAt: toIsoOrNull(row.decidedAt),
});

/** `ord` is assigned by the database on first insert and never rewritten. */
const toValues = (
  request: PermissionRequest,
): Omit<typeof permissionRequests.$inferInsert, 'ord'> => ({
  id: request.id,
  runId: request.runId,
  threadId: request.threadId,
  taskId: request.taskId,
  tool: request.tool,
  description: request.description,
  input: request.input as Record<string, unknown>,
  status: request.status,
  requestedAt: toDate(request.requestedAt),
  expiresAt: toDate(request.expiresAt),
  decidedAt: toDateOrNull(request.decidedAt),
});

export class PgPermissionRepository implements PermissionRepository {
  constructor(private readonly db: Executor) {}

  async get(id: string): Promise<PermissionRequest | null> {
    const [row] = await this.db
      .select()
      .from(permissionRequests)
      .where(eq(permissionRequests.id, id));
    return row === undefined ? null : toDomain(row);
  }

  async save(request: PermissionRequest): Promise<void> {
    const values = toValues(request);
    await this.db.insert(permissionRequests).values(values).onConflictDoUpdate({
      target: permissionRequests.id,
      set: values,
    });
  }

  async listPending(): Promise<readonly PermissionRequest[]> {
    const rows = await this.db
      .select()
      .from(permissionRequests)
      .where(eq(permissionRequests.status, 'pending'))
      .orderBy(asc(permissionRequests.requestedAt), asc(permissionRequests.ord));
    return rows.map(toDomain);
  }
}
