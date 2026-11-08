import type { MessageKind } from '@jarvis/shared';
import { DomainError } from './errors.js';
import type { Task } from './task.js';
import type { IsoTime } from './time.js';

export type MessageBody = Readonly<Record<string, unknown>>;

export interface Message {
  readonly id: string;
  /** Every message belongs to exactly one thread (ADR-0006). */
  readonly threadId: string;
  readonly taskId: string | null;
  readonly kind: MessageKind;
  readonly body: MessageBody;
  readonly at: IsoTime;
  /** Cards only: set once by `answerCard`. */
  readonly answer: MessageBody | null;
  readonly answeredAt: IsoTime | null;
}

const CARD_KINDS: readonly MessageKind[] = ['decision', 'question', 'permission'];

export function isCard(message: Pick<Message, 'kind'>): boolean {
  return CARD_KINDS.includes(message.kind);
}

export function isAnswered(message: Pick<Message, 'answeredAt'>): boolean {
  return message.answeredAt !== null;
}

/** SLK-06: a card takes one answer; a card of a cancelled task takes none. */
export function answerCard(
  message: Message,
  answer: MessageBody,
  at: IsoTime,
  task: Pick<Task, 'stage'> | null = null,
): Message {
  if (!isCard(message)) {
    throw new DomainError('not_a_card', `Message ${message.id} (${message.kind}) is not a card`);
  }
  if (isAnswered(message)) {
    throw new DomainError('already_answered', `Card ${message.id} is already answered`);
  }
  if (task?.stage === 'Cancelled') {
    throw new DomainError('task_cancelled', `Card ${message.id} belongs to a cancelled task`);
  }
  return { ...message, answer, answeredAt: at };
}
