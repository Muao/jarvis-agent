import type { MessageKind } from '@jarvis/shared';
import {
  answerCard,
  touchThread,
  type Message,
  type MessageBody,
  type Task,
} from '../../domain/index.js';
import { NotFoundError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { BodyOf } from './message-bodies.js';
import type { Outbox } from '../transaction.js';

export interface NewMessage {
  readonly threadId: string;
  readonly taskId: string | null;
  readonly kind: MessageKind;
  readonly body: MessageBody;
}

/** Creates and updates thread messages through the unit of work and queues their owner notifications. */
export class ThreadMessages {
  constructor(private readonly deps: { readonly ids: IdGenerator; readonly clock: Clock }) {}

  async post(tx: Repositories, outbox: Outbox, input: NewMessage): Promise<Message> {
    const thread = await tx.threads.get(input.threadId);
    if (thread === null) throw new NotFoundError('thread', input.threadId);
    const at = this.deps.clock.now();
    const message: Message = {
      id: this.deps.ids.messageId(),
      threadId: input.threadId,
      taskId: input.taskId,
      kind: input.kind,
      body: input.body,
      at,
      answer: null,
      answeredAt: null,
    };
    await tx.messages.add(message);
    await tx.threads.save(touchThread(thread, at));
    outbox.messageCreated(message);
    return message;
  }

  /** An owner message waiting for the dispatcher or the task's worker. */
  postOwner(
    tx: Repositories,
    outbox: Outbox,
    input: {
      threadId: string;
      taskId: string | null;
      text: string;
      /** Automatic worker input from the PR watcher is not the owner's words. */
      source?: BodyOf<'owner'>['source'];
    },
  ): Promise<Message> {
    const body: BodyOf<'owner'> = {
      text: input.text,
      delivery: 'queued',
      source: input.source ?? 'owner',
    };
    return this.post(tx, outbox, {
      threadId: input.threadId,
      taskId: input.taskId,
      kind: 'owner',
      body,
    });
  }

  /** Replace a message (status card body, delivery state) in place. */
  async replace(tx: Repositories, outbox: Outbox, message: Message): Promise<void> {
    await tx.messages.save(message);
    outbox.messageUpdated(message);
  }

  /** SLK-06: one answer per card, none once the task is cancelled (domain rule). */
  async answer(
    tx: Repositories,
    outbox: Outbox,
    card: Message,
    answer: MessageBody,
    task: Task | null,
  ): Promise<Message> {
    const answered = answerCard(card, answer, this.deps.clock.now(), task);
    await this.replace(tx, outbox, answered);
    return answered;
  }
}
