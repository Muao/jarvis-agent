import type { MessageDto, MessageKind } from '@jarvis/shared';

/** The body shape of one message kind, as the wire contract defines it. */
export type BodyOf<K extends MessageKind> = Extract<MessageDto, { kind: K }>['body'];
