import type { ThreadDetailDto } from '@jarvis/shared';
import { isAnswered, isCard } from '../../domain/index.js';
import { NotFoundError } from '../errors.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { toMessageDto } from './message-dto.js';
import { toThreadDto } from './thread-dto.js';
import { currentTaskOf } from './waiting.js';

/** `GET /api/threads/:id`: the thread with its messages, oldest first. */
export class GetThread {
  constructor(private readonly deps: { readonly uow: UnitOfWork }) {}

  execute(id: string): Promise<ThreadDetailDto> {
    return this.deps.uow.run(async (tx) => {
      const thread = await tx.threads.get(id);
      if (thread === null) throw new NotFoundError('thread', id);
      const messages = await tx.messages.listByThread(id);
      const task = currentTaskOf(await tx.tasks.listByThread(id));
      const hasOpenCard = messages.some((m) => isCard(m) && !isAnswered(m));
      return {
        ...toThreadDto(thread, task, hasOpenCard),
        dispatcherSessionId: (await tx.sessions.dispatcherOf(id))?.id ?? null,
        dispatcherBusy: await tx.runs.dispatcherBusy(id),
        messages: messages.map(toMessageDto),
      };
    });
  }
}
