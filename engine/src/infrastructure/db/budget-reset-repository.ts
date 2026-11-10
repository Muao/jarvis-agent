import { desc } from 'drizzle-orm';
import type { BudgetResetRepository } from '../../application/ports/budget-reset-repository.js';
import type { IsoTime } from '../../domain/index.js';
import type { Executor } from './client.js';
import { budgetResets } from './schema.js';
import { toDate, toIso } from './time.js';

export class PgBudgetResetRepository implements BudgetResetRepository {
  constructor(private readonly db: Executor) {}

  async append(at: IsoTime): Promise<void> {
    await this.db.insert(budgetResets).values({ at: toDate(at) });
  }

  async latest(): Promise<IsoTime | null> {
    const [row] = await this.db.select().from(budgetResets).orderBy(desc(budgetResets.at)).limit(1);
    return row === undefined ? null : toIso(row.at);
  }
}
