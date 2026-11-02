import { z } from 'zod';
import { CounterSchema, IsoDateSchema, TaskIdSchema, TextBodySchema } from '../common.js';
import { TaskStageSchema } from '../enums.js';

/* Answers to cards (one answer per card). */

export const DecisionAnswerSchema = z.strictObject({
  decision: z.enum(['approve', 'request_changes']),
  comment: z.string().min(1).optional(),
});
export const QuestionAnswerSchema = TextBodySchema;
export const PermissionAnswerSchema = z.strictObject({ decision: z.enum(['allow', 'deny']) });
export const CardAnswerSchema = z.union([
  DecisionAnswerSchema,
  QuestionAnswerSchema,
  PermissionAnswerSchema,
]);
export type CardAnswer = z.infer<typeof CardAnswerSchema>;

/** `POST /api/messages/:id/answer` — decision and question cards. */
export const AnswerMessageBodySchema = z.union([DecisionAnswerSchema, QuestionAnswerSchema]);
export type AnswerMessageBody = z.infer<typeof AnswerMessageBodySchema>;

/** `POST /api/permissions/:id` */
export const AnswerPermissionBodySchema = PermissionAnswerSchema;
export type AnswerPermissionBody = z.infer<typeof AnswerPermissionBodySchema>;

/** `POST /api/threads` (first message) and `POST /api/threads/:id/messages` */
export const PostMessageBodySchema = TextBodySchema;
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;

/* Message bodies, one shape per kind. */

const StepSchema = z.object({ label: z.string(), state: z.enum(['done', 'active', 'pending']) });

const MessageBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('owner'),
    body: z.object({
      text: z.string(),
      delivery: z.enum(['queued', 'delivered', 'failed']),
      /** `ci` and `review` are automatic worker inputs from the PR watcher; the UI shows them as system lines. */
      source: z.enum(['owner', 'ci', 'review']).default('owner'),
    }),
  }),
  z.object({ kind: z.literal('jarvis'), body: z.object({ text: z.string() }) }),
  z.object({
    kind: z.literal('status'),
    body: z.object({
      taskId: TaskIdSchema,
      stage: TaskStageSchema,
      /** The worker session, for `Open console →`; null until the first run starts. */
      workerSessionId: z.string().nullable().default(null),
      /** When the task started, for the elapsed time. Cards written before this field read as null. */
      startedAt: IsoDateSchema.nullable().default(null),
      steps: z.array(StepSchema),
      checks: CounterSchema,
      ciFixes: CounterSchema,
      reviews: CounterSchema,
    }),
  }),
  z.object({
    kind: z.literal('decision'),
    body: z.object({ taskId: TaskIdSchema, summary: z.string(), artifacts: z.array(z.string()) }),
  }),
  z.object({
    kind: z.literal('question'),
    body: z.object({ taskId: TaskIdSchema, question: z.string(), options: z.array(z.string()) }),
  }),
  z.object({
    kind: z.literal('permission'),
    body: z.object({
      permissionId: z.string(),
      requester: z.string(),
      toolName: z.string(),
      description: z.string().nullable(),
      input: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    kind: z.literal('result'),
    body: z.object({
      taskId: TaskIdSchema,
      summary: z.string(),
      prUrl: z.url().nullable(),
    }),
  }),
  z.object({ kind: z.literal('system'), body: z.object({ text: z.string() }) }),
]);

export const MessageDtoSchema = z.intersection(
  z.object({
    id: z.string(),
    threadId: z.string(),
    createdAt: IsoDateSchema,
    /** Set once a card is answered; never changes afterwards. */
    answer: CardAnswerSchema.nullable(),
    answeredAt: IsoDateSchema.nullable(),
  }),
  MessageBodySchema,
);
export type MessageDto = z.infer<typeof MessageDtoSchema>;

/** Row of `GET /api/threads`. */
export const ThreadDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  taskId: TaskIdSchema.nullable(),
  stage: TaskStageSchema.nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.url().nullable(),
  waitingForOwner: z.boolean(),
  lastActivityAt: IsoDateSchema,
});
export type ThreadDto = z.infer<typeof ThreadDtoSchema>;

/** `GET /api/threads/:id` and the result of `POST /api/threads`. */
export const ThreadDetailDtoSchema = ThreadDtoSchema.extend({
  dispatcherSessionId: z.string().nullable(),
  /** The dispatcher is handling a message ("thinking" indicator). */
  dispatcherBusy: z.boolean(),
  messages: z.array(MessageDtoSchema),
});
export type ThreadDetailDto = z.infer<typeof ThreadDetailDtoSchema>;
