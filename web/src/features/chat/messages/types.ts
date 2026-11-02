import type { MessageDto } from '@jarvis/shared';

export type MessageOf<K extends MessageDto['kind']> = Extract<MessageDto, { kind: K }>;

/** Props shared by every card that can be answered. */
export interface CardProps<K extends MessageDto['kind']> {
  message: MessageOf<K>;
  /** The thread's task was cancelled: unanswered cards turn inactive. */
  cancelled: boolean;
}
