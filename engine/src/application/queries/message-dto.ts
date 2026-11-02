import type { MessageDto } from '@jarvis/shared';
import type { Message } from '../../domain/index.js';

/**
 * A stored message as the wire shape. Bodies are written by the use cases in exactly the shapes
 * `MessageDto` describes (see `BodyOf`), so the mapping only adds the envelope; the one body that
 * grew a field later, the owner message `source`, gets its default here.
 */
export function toMessageDto(message: Message): MessageDto {
  const body = message.kind === 'owner' ? { source: 'owner', ...message.body } : message.body;
  return {
    id: message.id,
    threadId: message.threadId,
    createdAt: message.at,
    answer: message.answer,
    answeredAt: message.answeredAt,
    kind: message.kind,
    body,
  } as MessageDto;
}
