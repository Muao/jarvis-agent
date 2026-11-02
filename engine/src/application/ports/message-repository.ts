import type { Message } from '../../domain/index.js';

export interface MessageRepository {
  get(id: string): Promise<Message | null>;
  add(message: Message): Promise<void>;
  /** Update an existing message (status card body, card answer, delivery state). */
  save(message: Message): Promise<void>;
  /** The single status message of a task (SLK-07), if it was created. */
  statusCardOf(taskId: string): Promise<Message | null>;
  /** Decision, question and permission cards of the task that have no answer yet, oldest first. */
  openCards(taskId: string): Promise<readonly Message[]>;
  /** The card that asks for the permission request (SLK-05), if it was posted. */
  permissionCardOf(permissionId: string): Promise<Message | null>;
  /** Owner messages for the task's worker with `delivery: 'queued'`, oldest first (DSP-04). */
  queuedWorkerInput(taskId: string): Promise<readonly Message[]>;
  /** Owner messages in a thread without an active task with `delivery: 'queued'`, oldest first. */
  queuedDispatcherInput(threadId: string): Promise<readonly Message[]>;
  /** Threads that have queued owner messages for a dispatcher turn (restart recovery, ST-04). */
  threadsWithQueuedDispatcherInput(): Promise<readonly string[]>;
  /** Every message of the thread, oldest first. */
  listByThread(threadId: string): Promise<readonly Message[]>;
  /** Threads that have a decision, question or permission card nobody answered yet. */
  threadsWithOpenCards(): Promise<readonly string[]>;
}
