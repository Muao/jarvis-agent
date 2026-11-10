import type { IsoTime } from '../../domain/index.js';

/** The owner's "reset today's usage" moments (LIM-04). Append-only; the latest one counts. */
export interface BudgetResetRepository {
  append(at: IsoTime): Promise<void>;
  /** The newest reset, or null when there never was one. */
  latest(): Promise<IsoTime | null>;
}
