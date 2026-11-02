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

/**
 * What each Jarvis tool does and what the model gets back. Identity is always the run's, never an
 * argument (ADR-0005). `approve` is not here: it has its own long-polling route.
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
  reply: tool(schemas.reply, (app, identity, input) => app.reply.execute(identity, input)),

  report_stage: tool(schemas.report_stage, async (app, identity, input) => {
    await app.reportStage.execute(identity, input);
    return OK;
  }),
  ask_owner: tool(schemas.ask_owner, (app, identity, input) =>
    app.askOwner.execute(identity, input),
  ),
  submit_spec_for_approval: tool(schemas.submit_spec_for_approval, (app, identity, input) =>
    app.submitSpec.execute(identity, input),
  ),
  report_checks: tool(schemas.report_checks, (app, identity, input) =>
    app.reportChecks.execute(identity, input),
  ),
  report_pr: tool(schemas.report_pr, async (app, identity, input) => {
    await app.reportPr.execute(identity, input);
    return OK;
  }),
  log_note: tool(schemas.log_note, async (app, identity, input) => {
    await app.logNote.execute(identity, input);
    return OK;
  }),
};
