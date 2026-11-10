import { DomainError, type Message, type Task } from '../../domain/index.js';
import { transact } from '../transaction.js';
import type { Outbox } from '../transaction.js';
import { NotFoundError } from '../errors.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { TaskDeps } from './deps.js';
import { loadTask } from './guards.js';

/** WRK-05, SLK-06: the owner's answer unblocks the task, which resumes where it asked. */
export class AnswerQuestion {
  constructor(private readonly deps: TaskDeps) {}

  /** `POST /api/messages/:id/answer` on a question card. */
  execute(cardId: string, text: string): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const card = await tx.messages.get(cardId);
      if (card === null) throw new NotFoundError('message', cardId);
      assertQuestionCard(card);
      const task = await loadTask(tx, card.taskId);
      const input = await this.deps.messages.postOwner(tx, outbox, {
        threadId: task.threadId,
        taskId: task.id,
        text,
      });
      await this.answerWithin(tx, outbox, card, task, input);
    });
  }

  /**
   * Answer `card` with an owner message that already exists (a free-text reply in the thread counts
   * as the answer). The message stays queued: the resumed run reads it as its first input.
   */
  async answerWithin(
    tx: Repositories,
    outbox: Outbox,
    card: Message,
    task: Task,
    input: Message,
  ): Promise<void> {
    await this.deps.messages.answer(tx, outbox, card, { text: textOf(input) }, task);
    if (task.stage !== 'Blocked' || task.resumeStage === null) {
      throw new DomainError('illegal_transition', `Task ${task.id} is not waiting for an answer`);
    }
    await this.deps.writer.move(tx, outbox, task, task.resumeStage, { cause: 'owner_answered' });
    await this.deps.writer.note(tx, task.id, 'owner_input', 'owner', { messageId: input.id });
    outbox.requestWorkerRun(task.id, 'resume');
  }
}

function textOf(message: Message): string {
  const { text } = message.body;
  return typeof text === 'string' ? text : '';
}

function assertQuestionCard(card: Message): asserts card is Message & { taskId: string } {
  if (card.kind !== 'question' || card.taskId === null) {
    throw new DomainError('not_a_card', `Message ${card.id} is not a question card`);
  }
}
