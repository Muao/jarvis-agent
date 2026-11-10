import { DomainError, type Message, type Task } from '../../domain/index.js';
import { transact, type Outbox } from '../transaction.js';
import type { Repositories } from '../ports/unit-of-work.js';
import { InvalidInputError, NotFoundError } from '../errors.js';
import type { TaskDeps } from './deps.js';
import { loadTask } from './guards.js';

export interface DecisionAnswerInput {
  readonly decision: 'approve' | 'request_changes';
  readonly comment?: string;
}

/** WRK-04, SLK-06: the owner approves the spec and plan or sends the worker back with a comment. */
export class AnswerDecision {
  constructor(private readonly deps: TaskDeps) {}

  execute(cardId: string, answer: DecisionAnswerInput): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const card = await tx.messages.get(cardId);
      if (card === null) throw new NotFoundError('message', cardId);
      assertDecisionCard(card);
      const task = await loadTask(tx, card.taskId);
      await this.answerWithin(tx, outbox, card, task, answer);
    });
  }

  /**
   * Answer `card`. `input` is an owner message that already carries the comment (a free-text
   * reply in the thread); without it the comment is stored as a new queued owner message.
   */
  async answerWithin(
    tx: Repositories,
    outbox: Outbox,
    card: Message,
    task: Task,
    answer: DecisionAnswerInput,
    input?: Message,
  ): Promise<void> {
    const comment = answer.comment?.trim();
    if (answer.decision === 'request_changes' && !comment) {
      throw new InvalidInputError('Requesting changes needs a comment for the worker');
    }

    await this.deps.messages.answer(
      tx,
      outbox,
      card,
      comment ? { decision: answer.decision, comment } : { decision: answer.decision },
      task,
    );

    if (answer.decision === 'approve') {
      // ADR-0022: the card's list is what the owner read; approving freezes exactly that.
      const body = card.body as { checks?: unknown; checksSource?: unknown };
      if (Array.isArray(body.checks) && body.checks.length > 0) {
        await this.deps.writer.note(tx, task.id, 'checks_fixed', 'owner', {
          commands: body.checks,
          source: body.checksSource ?? null,
          cardId: card.id,
        });
      }
      await this.deps.writer.move(tx, outbox, task, 'Implementing', { cause: 'spec_approved' });
    } else {
      await this.deps.writer.move(tx, outbox, task, 'Context', {
        cause: 'spec_changes_requested',
      });
      const queued =
        input ??
        (await this.deps.messages.postOwner(tx, outbox, {
          threadId: task.threadId,
          taskId: task.id,
          text: comment ?? '',
        }));
      await this.deps.writer.note(tx, task.id, 'owner_input', 'owner', { messageId: queued.id });
    }
    outbox.requestWorkerRun(task.id, 'resume');
  }
}

/** Not a decision card (a question or permission card answered here) is a domain error, not "not found". */
function assertDecisionCard(card: Message): asserts card is Message & { taskId: string } {
  if (card.kind !== 'decision' || card.taskId === null) {
    throw new DomainError('not_a_card', `Message ${card.id} is not a decision card`);
  }
}
