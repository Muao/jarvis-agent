import { createThread, routeOwnerMessage, type OwnerMessageRoute } from '../../domain/index.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { AnswerDecision } from '../tasks/answer-decision.js';
import type { AnswerQuestion } from '../tasks/answer-question.js';
import type { TaskDeps } from '../tasks/deps.js';
import { findOpenCard } from '../tasks/guards.js';
import { transact, type Outbox } from '../transaction.js';

export interface PostedOwnerMessage {
  readonly threadId: string;
  readonly messageId: string;
  readonly route: OwnerMessageRoute;
}

const TITLE_LENGTH = 60;

function titleOf(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

/**
 * SLK-01, SLK-02, DSP-04: an owner message opens a thread or continues one, and is routed.
 * No active task in the thread -> the dispatcher; an active task -> its worker, and a text reply
 * while the task waits on a question card answers that card.
 */
export class PostOwnerMessage {
  constructor(
    private readonly deps: TaskDeps & {
      readonly ids: IdGenerator;
      readonly answerQuestion: AnswerQuestion;
      readonly answerDecision: AnswerDecision;
    },
  ) {}

  /** `threadId` absent: the message starts a new thread. */
  execute(input: {
    readonly threadId?: string;
    readonly text: string;
  }): Promise<PostedOwnerMessage> {
    return transact(this.deps, async (tx, outbox) => {
      const threadId = input.threadId ?? (await this.openThread(tx, outbox, input.text));
      const task = await tx.tasks.activeForThread(threadId);
      const route = routeOwnerMessage({
        task,
        dispatcherBusy: task === null && (await tx.runs.dispatcherBusy(threadId)),
      });
      const message = await this.deps.messages.postOwner(tx, outbox, {
        threadId,
        taskId: task?.id ?? null,
        text: input.text,
      });

      if (task !== null) {
        const cards = await tx.messages.openCards(task.id);
        const question = findOpenCard(cards, 'question');
        const decision = task.stage === 'Spec Review' ? findOpenCard(cards, 'decision') : null;
        if (question !== null) {
          await this.deps.answerQuestion.answerWithin(tx, outbox, question, task, message);
        } else if (decision !== null) {
          // WRK-04: a comment instead of an approval sends the worker back to the spec.
          const answer = { decision: 'request_changes', comment: input.text } as const;
          await this.deps.answerDecision.answerWithin(tx, outbox, decision, task, answer, message);
        } else {
          await this.deps.writer.note(tx, task.id, 'owner_input', 'owner', {
            messageId: message.id,
          });
          outbox.deliverToWorker(task.id);
        }
      } else if (route === 'dispatcher') {
        outbox.requestDispatcherTurn(threadId);
      }
      return { threadId, messageId: message.id, route };
    });
  }

  private async openThread(tx: Repositories, outbox: Outbox, text: string): Promise<string> {
    const thread = createThread({
      id: this.deps.ids.threadId(),
      title: titleOf(text),
      at: this.deps.clock.now(),
    });
    await tx.threads.save(thread);
    outbox.threadChanged(thread.id);
    return thread.id;
  }
}
