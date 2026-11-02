import type { TransactionDeps } from '../transaction.js';
import type { ThreadMessages } from '../conversation/thread-messages.js';
import type { Clock } from '../ports/clock.js';
import type { TaskWriter } from './task-writer.js';

/** What every task use case needs: the transaction, the post-commit ports and the shared writers. */
export interface TaskDeps extends TransactionDeps {
  readonly clock: Clock;
  readonly writer: TaskWriter;
  readonly messages: ThreadMessages;
}
