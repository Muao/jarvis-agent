import { toolInputSchemas, type ToolName } from '@jarvis/shared';
import type { ZodType } from 'zod';
import type { Application, RunIdentity } from '../../../application/index.js';
import { parse } from '../parse.js';

const OK = { ok: true } as const;
const schemas = toolInputSchemas;

type Call = (app: Application, identity: RunIdentity, body: unknown) => Promise<unknown>;

/** Binds a tool's input schema (the body is untrusted) to the use case that serves it. */
function tool<T>(
  schema: ZodType<T>,
  run: (app: Application, identity: RunIdentity, input: T) => Promise<unknown>,
): Call {
  return (app, identity, body) => run(app, identity, parse(schema, body));
}

const RETIRED = {
  ok: false,
  reason: 'tool_retired',
  use: 'open_pr',
  detail:
    'Checks, push and the pull request are now done by the engine: commit, then call open_pr.',
} as const;
const retired: Call = () => Promise.resolve(RETIRED);

/** Tools no role is offered any more but a worker session started earlier may still call (ADR-0022). */
export const RETIRED_TOOLS: readonly ToolName[] = ['report_checks', 'report_pr'];

/**
 * What each Jarvis tool does and what the model gets back. Identity is always the run's, never an
 * argument (ADR-0004). `approve` is not here: it has its own long-polling route.
 */
export const toolCalls: Readonly<Partial<Record<ToolName, Call>>> = {
  create_task: tool(schemas.create_task, (app, identity, input) =>
    app.createTask.execute(identity, input),
  ),
  list_tasks: tool(schemas.list_tasks, (app, identity) => app.listTasks.execute(identity)),
  cancel_task: tool(schemas.cancel_task, async (app, identity, input) => {
    await app.cancelTask.execute(
      { taskId: input.task, ...(input.reason === undefined ? {} : { reason: input.reason }) },
      identity,
    );
    return OK;
  }),
  send_to_task: tool(schemas.send_to_task, async (app, identity, input) => {
    await app.sendToTask.execute(identity, { taskId: input.task, message: input.message });
    return OK;
  }),
  set_task_target_repo: tool(schemas.set_task_target_repo, async (app, identity, input) => {
    await app.setTaskTargetRepo.execute(identity, { taskId: input.task, repo: input.repo });
    return OK;
  }),
  reply: tool(schemas.reply, (app, identity, input) => app.reply.execute(identity, input)),
  remember: tool(schemas.remember, async (app, identity, input) => ({
    ...OK,
    ...(await app.remember.execute(identity, input)),
  })),
  forget: tool(schemas.forget, async (app, identity, input) => {
    await app.forget.execute(identity, input);
    return OK;
  }),
  merge_insights: tool(schemas.merge_insights, async (app, identity, input) => ({
    ...OK,
    ...(await app.mergeInsights.execute(identity, input)),
  })),
  read_memory: tool(schemas.read_memory, (app, identity) => app.readMemory.execute(identity)),
  update_config: tool(schemas.update_config, (app, identity, input) =>
    app.updateConfig.execute(identity, input),
  ),

  report_stage: tool(schemas.report_stage, async (app, identity, input) => {
    await app.reportStage.execute(identity, input);
    return OK;
  }),
  ask_owner: tool(schemas.ask_owner, (app, identity, input) =>
    app.askOwner.execute(identity, input),
  ),
  submit_spec_for_approval: tool(schemas.submit_spec_for_approval, (app, identity, input) =>
    app.submitSpec.attempt(identity, input),
  ),
  open_pr: tool(schemas.open_pr, (app, identity, input) => app.openPr.execute(identity, input)),
  // Migration only (ADR-0022): a session that started before `open_pr` still calls these. The
  // answer is a value, not an error, so the model reads it and changes course. Remove one release
  // after the journal shows no `tool_retired` answer for a week.
  report_checks: retired,
  report_pr: retired,
  log_note: tool(schemas.log_note, async (app, identity, input) => {
    await app.logNote.execute(identity, input);
    return OK;
  }),
  post_update: tool(schemas.post_update, async (app, identity, input) => {
    await app.postUpdate.execute(identity, input);
    return OK;
  }),

  note_insight: tool(schemas.note_insight, async (app, identity, input) => ({
    ...OK,
    ...(await app.noteInsight.execute(identity, input)),
  })),
  confirm_insight: tool(schemas.confirm_insight, (app, identity, input) =>
    app.confirmInsight.execute(identity, input),
  ),
  contradict_insight: tool(schemas.contradict_insight, (app, identity, input) =>
    app.contradictInsight.execute(identity, input),
  ),
  remember_owner: tool(schemas.remember_owner, async (app, identity, input) => ({
    ...OK,
    ...(await app.rememberOwner.execute(identity, input)),
  })),

  start_dev_server: tool(schemas.start_dev_server, (app, identity) =>
    app.startDevServer.execute(identity),
  ),
  stop_dev_server: tool(schemas.stop_dev_server, (app, identity) =>
    app.stopDevServer.execute(identity),
  ),
  attach_image: tool(schemas.attach_image, (app, identity, input) =>
    app.attachImage.execute(identity, input),
  ),
  comment_on_pr: tool(schemas.comment_on_pr, (app, identity, input) =>
    app.commentOnPr.execute(identity, input),
  ),
};
