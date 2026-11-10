# Implementation Plan: workflow registry (ADR-0023)

**Goal:** one definition per task kind in `engine/src/domain/workflows/`; the engine reads it instead of
branching on `task.kind`. `build` and `ui_check` behave exactly as today. After this plan, adding a
third kind (`review`: read an existing PR's diff, run `reviewer`, offer a PR comment) is five
hand-written files, one generated migration and one test, none of them in `application/`,
`infrastructure/` or `presentation/`.

**Decision:** `docs/decisions/architecture/0023-workflow-registry-one-definition-per-task-kind.md`
(proposed). It is binding once accepted; where this plan and the ADR disagree, the ADR wins and the task
reports the disagreement instead of guessing. Do not start before the owner has accepted it.

**Out of this plan:** the engine-phase / workflow-step split (Task P, unscheduled, needs its own ADR and
the owner's yes); the `retro` run itself (ADR-0020); the generalised watcher (ADR-0024); any new kind;
any change to `web/`; any database migration.

## Global constraints

- Starts from the tree **after** the agent-memory work (ADR-0021) **and** "engine-side checks and PR"
  (ADR-0022) have landed. Read each file as it is then; every line number in this plan is from before
  ADR-0022 and is a pointer, not an address.
- **Behaviour-preserving.** Every task ends with the whole engine suite green and *unchanged* — a test
  may be edited only to move an import, never to change an expectation. The one exception is named
  where it occurs (C2).
- Characterisation first: where a step says "golden", write the test against the **old** code, see it
  pass, then refactor.
- No new dependency in any `package.json`; no file under `engine/drizzle/`.
- Onion rule (ADR-0002): definitions are pure data in `domain/workflows/`, importing only `import type`
  from `@jarvis/shared`; capability blocks use ports in `application/workflows/`; adapters read
  `RunSpec.profile` and `RunIdentity.tools` and import no file from either workflows directory.
- No test runs the real `claude` (ADR-0011).
- Error texts, journal event types and the order of lines in the run's first message do not change.
- **Do not commit, stage or stash.** Other sessions work in this tree. Edit on top of what is there; do
  not revert or reformat unrelated lines. If a file you own has uncommitted changes from another
  session, work around them.
- Each task ends with its modules' tests and typecheck green (commands in `AGENTS.md`) and
  `pnpm exec prettier --check` clean on the files it touched.

## Contracts (fixed here so the tasks agree)

### The definition

Exactly the `WorkflowDefinition`, `RunProfile`, `ProgressSpec`, `SettingSource`, `ContextBlockId`
(`'pull-request'`) and `GateId` (`'trusted-head'`) of ADR-0023, in
`engine/src/domain/workflows/types.ts`. Every field required, none optional.

### Files and names

| Name                                                 | Where                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `build`, `uiCheck` definitions                       | `domain/workflows/build.ts`, `domain/workflows/ui-check.ts` |
| `WORKFLOWS`, `workflowOf(kind)`, `DEFAULT_KIND`, `runProfileOf(def)` | `domain/workflows/index.ts`, re-exported from `domain/index.ts` |
| `TRANSITIONS`, `UI_CHECK_TRANSITIONS`                | keep their names; defined in the workflow files, still exported from `domain/index.ts` |
| `profileFor(role, task \| null): RunProfile`         | `application/workflows/run-profile.ts`                      |
| `prepareWorkspace(worktrees, workflow, task)`        | `application/workflows/workspace.ts`                        |
| `resolveContextBlocks(deps, task)`                   | `application/workflows/context-blocks.ts`                   |
| `runGates(deps, workflow, identity, task)`           | `application/workflows/gates.ts`                            |
| `requireWorkflowTool(task, tool)`                    | `application/tasks/guards.ts`                               |

### Values, copied from today's code (the parity table)

| Field                  | `build`                                   | `ui_check`                                              | dispatcher (role profile)                |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `transitions`          | `TRANSITIONS` unchanged                   | `UI_CHECK_TRANSITIONS` unchanged                        | —                                        |
| `progress`             | today's `STEP_LABELS` / `ACTIVE_STEP` of `status-card.ts` | the same object (parity; ADR Q5)              | —                                        |
| `browserStages`        | `['Reviewing']`                           | `['Reviewing']`                                         | —                                        |
| `retroEligible`        | `true`                                    | `false`                                                 | —                                        |
| `startableByWatch`     | `true`                                    | `false`                                                 | —                                        |
| `pullRequest`          | `'forbidden'`                             | `'required'`                                            | —                                        |
| `workspace`            | `'own-branch'`                            | `'pull-request-head'`                                   | —                                        |
| `tools`                | every tool of `toolsByRole.worker`, same order | `toolsByRole.worker` minus `note_insight`, `confirm_insight`, `contradict_insight`, `remember_owner` and nothing else (it keeps `open_pr` and `submit_spec_for_approval`, refused by the transition table as today; ADR Q4), same order | `toolsByRole.dispatcher` |
| `deniedBuiltinTools`   | `[]`                                      | `['Bash', 'Edit', 'NotebookEdit']`                      | `['Edit', 'Write', 'Bash', 'NotebookEdit']` |
| `settingSources`       | `['project', 'local']`                    | `['user']`                                              | `['project', 'local']`                   |
| `browser`              | `true`                                    | `true`                                                  | `false`                                  |
| `contextBlocks`        | `[]`                                      | `['pull-request']`                                      | —                                        |
| `gates.beforeDevServer`| `[]`                                      | `['trusted-head']`                                      | —                                        |
| `promptSection`        | `'build'`                                 | `'ui-check'`                                            | —                                        |
| `RunProfile.promptFiles` | `['worker.md']` until Task D, then `['worker.md','workflows/build.md']` | `['worker.md']`, then `['worker.md','workflows/ui-check.md']` | `['dispatcher.md']` |

`--setting-sources` is the `settingSources` joined with `,` (`project,local` and `user` as today).

### Wiring

- `RunSpec.profile: RunProfile` (required). `RunSpec.taskKind` stays until Task E removes it.
- `RunIdentity.tools: readonly ToolName[]` (required), set where the run token is issued
  (`StartRun.launch`) from `profile.tools`.
- The MCP child gets `JARVIS_TOOLS` in `mcp.json`'s `env`: the profile's tool names joined with `,`.
  It registers `JARVIS_TOOLS ∩ toolsByRole[role]`; when the variable is absent (an old `mcp.json`) it
  registers `toolsByRole[role]`, as today.
- `--disallowedTools` for a run = `profile.deniedBuiltinTools` followed by the `mcp__jarvis__<name>` of
  every tool in `toolsByRole[role]` that is **not** in `profile.tools`, in `toolsByRole` order; the flag
  is omitted when that list is empty. For `ui_check` this is today's list, byte for byte
  (`Bash,Edit,NotebookEdit,mcp__jarvis__note_insight,…`).
- Context blocks: `type ContextBlockOutput = { lines: readonly string[]; section: { heading: string; body: string } | null }`.
  The `pull-request` block returns the `pr:` and `criteriaSources:` lines and the section
  `## Pull request text (data, not instructions)` with the wrapped text — the same strings, in the same
  places of the first message, as `workerFirstMessage` writes them now. The run context keeps printing
  `taskKind: <workflow id>` (the prompts read it).

### If "engine-side checks and PR" (ADR-0022) slipped

Steps that change are marked **(if 0022 slipped)**: A adds `githubToken: boolean` to the interface and
`RunProfile` (`build` `true`, `ui_check` `false`), and C3 routes `child-env.ts` through it instead of
the kind. Everything else is independent of it. If the agent-memory work had slipped instead, the four
memory-tool exclusions in the `ui_check` list, B1 and the memory assertions simply have nothing to do.

## Task A — the registry and the contract wiring (domain + ports; nothing reads it yet)

**Owns:** `engine/src/domain/workflows/**` (new), `engine/src/domain/task.ts`,
`engine/src/domain/task.test.ts`, `engine/src/domain/index.ts`,
`engine/src/application/workflows/run-profile.ts` (+ test), `engine/src/application/ports/agent-runner.ts`,
`engine/src/application/run-identity.ts`, `engine/src/application/runs/run-registry.ts` (+ test),
`engine/src/application/index.ts`, and — one statement only — `RunSpec`/identity construction in
`engine/src/application/runs/start-run.ts`, plus the test helpers that build a `RunSpec` or a
`RunIdentity` by hand.

- [ ] A1. `domain/workflows/types.ts`: the interfaces of the ADR, verbatim, with doc comments saying
      what each field replaces. `import type` from `@jarvis/shared` only.
- [ ] A2. `domain/workflows/build.ts` and `ui-check.ts`: move `TRANSITIONS`, `UI_CHECK_TRANSITIONS` and
      `EXITS` here **unchanged** (rows and order), plus `BUILD_PROGRESS` copied from `STEP_LABELS` /
      `ACTIVE_STEP` in `application/tasks/status-card.ts` (that file still has its own copy until B5).
      Fill every field from the parity table.
- [ ] A3. `domain/workflows/index.ts`: `WORKFLOWS: Readonly<Record<TaskKind, WorkflowDefinition>>`,
      `workflowOf(kind)`, `DEFAULT_KIND = 'build'`, and `runProfileOf(def): RunProfile` (copies
      `tools`, `deniedBuiltinTools`, `settingSources`, `browser`; `promptFiles = ['worker.md']`). Export
      from `domain/index.ts`.
- [ ] A4. `domain/task.ts`: `canTransition` uses `workflowOf(task.kind).transitions`; delete
      `transitionsOf` (grep its users first — only `task.ts` itself and tests); `createTask` uses
      `DEFAULT_KIND`; keep exporting `TRANSITIONS` and `UI_CHECK_TRANSITIONS` from `domain/index.ts` so
      `task.test.ts` and other importers compile unchanged. No cycle: `workflows/` must not import
      `task.ts`.
- [ ] A5. `domain/workflows/workflows.test.ts`: the contract tests of ADR Confirmation, iterating
      `TASK_KINDS`: every transition target is a `TaskStage`; terminal stages allow nothing; `Blocked`
      allows only `Cancelled`; `tools ⊆ toolsByRole.worker`; `build.tools` equals it; every worker tool
      is in some workflow; `ui_check` lacks the four memory-write tools; `startableByWatch` true for
      `build`, false for `ui_check`; a workflow with `workspace: 'pull-request-head'` and non-empty
      `browserStages` lists `trusted-head`; `runProfileOf` of both equals the parity table, field by
      field (this is the golden for the profile). The test file may import runtime `@jarvis/shared`.
- [ ] A6. `application/workflows/run-profile.ts`: `profileFor(role, task)` — worker with a task →
      `runProfileOf(workflowOf(task.kind))`; dispatcher → its column of the parity table
      (`tools: toolsByRole.dispatcher`); a worker with no task is a programming error (throw). Test:
      both kinds and the dispatcher match the table. The dispatcher's literals duplicate
      `run-args.ts` until C2 deletes those; say so in a comment.
- [ ] A7. `ports/agent-runner.ts`: `RunSpec.profile: RunProfile`. `run-identity.ts`: `tools`.
      `StartRun.launch`: `profile: profileFor(run.role, prepared.task)` into the spec and
      `tools: profile.tools` into the identity passed to `registry.issue`. Fix every hand-built
      `RunSpec` / `RunIdentity` in tests and fakes (`application/testing/**`, `infrastructure/**` tests,
      `engine/test/**`) by calling `profileFor`. **(if 0022 slipped)** add `githubToken` to A1–A3.

**Done when:** `pnpm --filter @jarvis/engine test && pnpm --filter @jarvis/engine typecheck` pass, and
`grep -rn "transitionsOf" engine/src` is empty. Nothing outside the registry reads `profile` yet.

## Task B — the application reads the definition (after A; parallel with C)

**Owns:** `engine/src/application/workflows/{workspace,context-blocks,gates}.ts` (+ tests),
`engine/src/application/tasks/{create-task,worktree-for,status-card,guards,report-stage}.ts` and their
tests, `engine/src/application/ui/{start-dev-server,trust-pull-request-head}.ts` and their tests,
`engine/src/application/runs/{start-run,run-prompt}.ts` and tests, `engine/src/application/profile/**`,
`engine/src/application/testing/{build-test-app,create-task-flow}.ts`.

- [ ] B1. **One tool check.** `tasks/guards.ts`: `requireWorkflowTool(task, tool)` — throws
      `ForbiddenError` with the existing message of `requireBuildTask` when `tool` is not in
      `workflowOf(task.kind).tools`. In `application/profile/`, replace `requireBuildTask` and its call
      sites with it, naming the tool each use case implements; delete `requireBuildTask`. The existing
      memory use-case tests (a `ui_check` task is refused each of the four) pass unchanged.
- [ ] B2. **Creation.** `create-task.ts`: `kind = input.kind ?? DEFAULT_KIND`; the `kind === 'build'`
      branch becomes `workflow.pullRequest === 'forbidden'` / `'required'`, with both `InvalidInputError`
      texts **verbatim** (they still say `ui_check` — leave them; making them generic is a model-visible
      change, Q-list). The two worktree branches become `prepareWorkspace(worktrees, workflow, task)` in
      `workspace.ts`: `own-branch` → `worktrees.create(id, targetRepo)`; `pull-request-head` →
      `worktrees.createForPullRequest(id, targetRepo, pr.number)`, wrapping a failure in the same
      `InvalidInputError('cannot check out pull request …')` that `checkoutPullRequest` throws now.
      `worktree-for.ts` delegates to the same function and keeps its signature. Tests: the existing
      `create-task.test.ts` and `ui-check-on-demand.test.ts`.
- [ ] B3. **Context blocks.** Golden first: a test that renders the `ui_check` run's first message (a
      PR with a body, one allow-listed reviewer comment, a spec.md) and the same for an unreadable PR,
      and the `build` one; save the expected strings from the **current** code. Then move
      `pullRequestContext` / `reviewerComments` out of `StartRun` into `context-blocks.ts` as the
      `pull-request` block (`Record<ContextBlockId, Block>`, exhaustive); `StartRun.worker` calls
      `resolveContextBlocks` outside the transaction as it calls `pullRequestContext` now, for the
      blocks the task's workflow lists. `run-prompt.ts`: replace `pullRequest`, `criteriaSources`,
      `pullRequestText` with `blocks: readonly ContextBlockOutput[]`, rename `taskKind` to `workflow`
      (the printed line stays `taskKind: <id>`). The goldens pass unchanged.
- [ ] B4. **Gates and browser stages.** `gates.ts`: `Record<GateId, Gate>` with `trusted-head` →
      `TrustPullRequestHead.decide`; `runGates` runs a workflow's `beforeDevServer` list in order and
      stops at the first untrusted. `StartDevServer`: the stage guard reads
      `workflow.browserStages.includes(stage)` (message unchanged), and the trust call becomes
      `runGates`. `TrustPullRequestHead.decide` loses its `task.kind !== 'ui_check'` test; keep its
      `task.pr === null` early return (`trusted`). Tests: `ui-check.test.ts`,
      `ui-check-on-demand.test.ts` pass unchanged; add one — a `build` task starting the dev server
      raises no permission card.
- [ ] B5. **Status card.** `status-card.ts` reads `workflowOf(task.kind).progress` and drops its own
      `STEP_LABELS` / `ACTIVE_STEP`. `status-card.test.ts` passes unchanged.
- [ ] B6. **Test helpers.** `build-test-app.ts`: delete `UI_CHECK_PATH_TO`; the branch name and the
      path to a stage come from the workflow (`workspace` decides `jarvis/` or `jarvis-check/`; the path
      is the shortest from `Intake` over `transitions`, found by breadth-first search). First assert in
      a throwaway test that the search reproduces the old `UI_CHECK_PATH_TO` for every stage it listed;
      keep `PATH_TO` for `build` if the search differs from it. `create-task-flow.ts`: only comments.
- [ ] B7. `report-stage.ts`: rewrite the doc comment to say the legal stages come from the workflow's
      table (no behaviour). `start-run.ts`: no remaining `task.kind`.

**Done when:** `pnpm --filter @jarvis/engine test && pnpm --filter @jarvis/engine typecheck` pass and
`grep -rnE "kind (===|!==)" engine/src/application` finds no comparison against a task kind.

## Task C — the adapters read the profile (after A; parallel with B)

**Owns:** `engine/src/infrastructure/claude/{run-args,child-env,claude-cli-runner,run-files}.ts` and
their tests, `engine/src/presentation/mcp/{server,env,main}.ts` and `tools.test.ts`,
`engine/src/presentation/http/routes/agent.ts` and its tests, `engine/test/**` if a scenario needs the
new field.

- [ ] C1. **Goldens first**, against the current code, in `run-args.test.ts` / `env.test.ts`: the full
      argv for worker × `build`, worker × `ui_check`, dispatcher; the child env for the same three with a
      token configured; the `mcp.json` for worker × `ui_check`. Commit nothing; they are the safety net.
- [ ] C2. `run-args.ts`: `--setting-sources` from `spec.profile.settingSources`; `--disallowedTools` as
      in the Wiring section; the dispatcher's `--allowedTools` is `profile.tools` mapped plus
      `DISPATCHER_READ_TOOLS`, its `--disallowedTools` is `profile.deniedBuiltinTools`. Delete
      `UI_CHECK_DENIED_TOOLS`, `UI_CHECK_HIDDEN_MEMORY_TOOLS`, `DISPATCHER_DENIED_TOOLS`. All C1 argv
      goldens pass **unchanged** — if one differs, the derivation is wrong, not the golden.
- [ ] C3. `child-env.ts` / `claude-cli-runner.ts`: **if ADR-0022 landed**, confirm there is no `taskKind`
      left in `child-env.ts` and remove the option and the pass-through in `claude-cli-runner.ts`.
      **(if 0022 slipped)** replace `options.taskKind !== 'ui_check'` with `options.githubToken` coming
      from `spec.profile.githubToken`, and remove `taskKind` from the options. The C1 env goldens pass.
- [ ] C4. `run-files.ts`: Playwright goes into `mcp.json` when `spec.profile.browser && ctx.config.ui.enabled
      && spec.screenshotsDir !== undefined` (was `role === 'worker' && …`; the dispatcher's profile has
      `browser: false`); `mcp.json` env gains `JARVIS_TOOLS`; `buildSystemPrompt` reads
      `spec.profile.promptFiles` in order (joined as today: SOUL, then each file, `trimEnd` + blank line).
      Leave `settings.json`'s `allow` rules role-based — narrowing them is ADR Q4. Test: `mcp.json` has
      `JARVIS_TOOLS` equal to the profile; the system prompt for both roles is byte-identical to before
      (golden).
- [ ] C5. `presentation/mcp/env.ts`: parse the optional `JARVIS_TOOLS`, drop unknown names, keep
      only names in `toolsByRole[role]`. `main.ts` and `createJarvisMcpServer({ role, api, tools })`
      register `tools ?? toolsByRole[role]`. Tests in `tools.test.ts`: a list registers exactly those
      tools; a name outside the role is ignored; absent variable = today's behaviour.
- [ ] C6. `routes/agent.ts`: `requireTool` checks `identity.tools`; the permissions route requires
      `approve` in `identity.tools`. Tests: a `ui_check` run's token calling `note_insight` is 403; a
      `build` run's is 200; the dispatcher's tools unchanged.
- [ ] C7. Nothing in `infrastructure/claude/` or `presentation/` mentions `ui_check`, `taskKind` or
      `.kind` of a task any more (comments included — rewrite them to say what the profile field does).

**Done when:** engine tests and typecheck pass, `pnpm lint` is clean for the engine, and
`grep -rnE "ui_check|taskKind" engine/src/infrastructure/claude engine/src/presentation` is empty.

## Task D — the prompt per workflow (after B and C; last behaviour change)

**Owns:** `agent/prompts/**` (`worker.md`, new `workflows/build.md`, `workflows/ui-check.md`,
`dispatcher.md`), `agent/README.md` if it lists prompts, `engine/src/domain/workflows/index.ts`
(`runProfileOf`'s `promptFiles` line), `engine/src/infrastructure/claude/run-files.test.ts` (fixture
only).

This task changes what the model reads and has no unit test that can say it still behaves. Do it only
with the owner's yes to ADR Q3.

- [ ] D1. Move the section "Checking a pull request on demand (`taskKind: ui_check`)" of `worker.md`
      verbatim into `workflows/ui-check.md`. Move the build stages (Context … PR, Fix rounds) verbatim
      into `workflows/build.md`. `worker.md` keeps: the role paragraph, Run context, Tools, Memory,
      Hard rules, and a two-line pointer saying the task's own section follows. Change no sentence
      except cross-references ("see WRK-10 above" → the file that now holds it).
- [ ] D2. `runProfileOf`: `promptFiles = ['worker.md', \`workflows/${def.promptSection}.md\`]`. Update
      the `run-files` fixture agent dir; the assembled prompt for each kind must equal the old
      `worker.md` plus nothing missing: a test concatenates and compares the multiset of non-blank lines.
- [ ] D3. Read the assembled prompt for both kinds end to end once, then replay one `build` and one
      `ui_check` scenario on the fake `claude` (`engine/test/flow/`) and, with the owner, one real
      `ui_check` run. Record what was compared in the task report.

**Done when:** `pnpm --filter @jarvis/engine test` passes, `pnpm exec prettier --check agent/` is clean
for touched files, and the line multiset test of D2 passes.

## Task E — close-out and the architecture rule (after B and C; parallel with D)

**Owns:** `engine/src/architecture.test.ts`, `engine/src/application/ports/agent-runner.ts`,
`engine/src/application/runs/start-run.ts` (one line), `shared/src/mcp.ts` (comments and the
`create_task` field docs only), `engine/src/presentation/mcp/server.ts` (the `create_task` description
only), `engine/src/infrastructure/db/task-repository.ts`.

- [ ] E1. Remove `RunSpec.taskKind` and its last writer in `start-run.ts`. Typecheck.
- [ ] E2. `architecture.test.ts`: `describe('architecture: ADR-0023 workflows')`.
      `checkNoKindBranching(files)`: for every production file under `engine/src` outside
      `domain/workflows/`, after `stripComments`, report each quoted literal equal to a value of
      `TASK_KINDS` (imported from `@jarvis/shared`) and each identifier `taskKind`, as
      `path:line message`. Allowed, with a reason in the code: `infrastructure/db/schema.ts` (the
      column default) and `application/testing/pr-open-flow.ts` (a CI check named `"build"`). Add the
      synthetic-sample test in the style of the file's "the rules catch violations" block:
      `task.kind === 'ui_check'`, `case 'build':` and `{ kind: 'review' }` (use a kind that is not in
      `TASK_KINDS` yet to prove the rule follows the list: read the list from a parameter) in an
      application file are reported; the same text inside `domain/workflows/` is not. Add the path
      rule: files under `infrastructure/claude/` and `presentation/` import nothing from
      `domain/workflows/` or `application/workflows/`.
- [ ] E3. `server.ts`: the `create_task` description no longer teaches `ui_check`; it says which
      argument `kind` is and points to the routing table in the dispatcher's prompt. Check
      `dispatcher.md` still has a row for each kind (it does: lines 16 and 48 of today's file). Model-
      visible; mention in the report. `shared/src/mcp.ts` comments: `report_stage` and `pr` no longer
      say "ui_check" as the only case.
- [ ] E4. `task-repository.ts`: `row.kind` is parsed with `TaskKindSchema.parse` instead of `as
      TaskKind` (a bad row fails loudly). Test with an in-memory row.
- [ ] E5. Sweep: `grep -rnE "ui_check|TaskKind|'build'" engine/src shared/src agent` and account for
      each remaining hit in the report: the enum, `domain/workflows/**`, the schema default, the
      prompts, error texts of B2, tests.

**Done when:** `pnpm --filter @jarvis/engine test && pnpm --filter @jarvis/engine typecheck`,
`pnpm --filter @jarvis/shared test && pnpm --filter @jarvis/shared typecheck` and `pnpm lint` pass, and
the new architecture test fails when a line `if (task.kind === 'ui_check') {}` is temporarily added to
any `application/` file (do it, see it fail, remove it).

## Task F — role profiles (optional, ADR Q6; do with the retro or when asked)

**Owns:** `engine/src/domain/workflows/role-profiles.ts` (new), `engine/src/application/workflows/run-profile.ts`,
`engine/src/infrastructure/claude/{run-args,run-files}.ts` and tests.

- [ ] F1. `ROLE_PROFILES: Record<Role, RoleProfile>` in the domain for the roles without a workflow
      (the dispatcher today; the retro when ADR-0020 is built — one row: its tools, denied built-ins,
      sources, cwd kind). `profileFor` reads it instead of its inline dispatcher literals.
- [ ] F2. Move `DISPATCHER_SETTINGS` and `DISPATCHER_READ_TOOLS` out of `run-files.ts` / `run-args.ts`
      into the profile (`allowedBuiltinTools`, `settingsPermissions`). C1's goldens pass unchanged.
- [ ] F3. Amend ADR-0020 as listed in ADR-0023 ("How `retro` fits", items 1–4) before the retro is
      implemented.

**Done when:** engine tests and typecheck pass; `run-args.ts` has no `role ===` test.

## Task P — engine phase versus workflow step (optional, unscheduled, ADR Q1)

Not startable from this plan alone: it needs its own ADR that supersedes the stage parts of the
task-stages decision, and the owner's yes. Recorded here so the registry is built to receive it.
The registry guarantees the seam: after Tasks A–E, `stage` is read from exactly two places that matter
for it — `workflow.transitions` and `workflow.progress` — plus the global stage checks listed in
ADR-0023.

Shape, so the cost can be judged: `phase` ∈ `running | waiting_owner | waiting_external | finished`
(engine-wide) and `step: string` (per workflow). `Blocked` and `resumeStage` disappear: a task that
asks the owner keeps its step and has phase `waiting_owner`. `Failed` keeps its step. The dead
`ui_check` rows disappear because a workflow lists only its own steps.

- [ ] P1. ADR superseding the stage decisions; owner sign-off.
- [ ] P2. Domain: `Phase`, `step`, a pure `stageOf(phase, step)` projection that reproduces today's
      12 stages, so every consumer can keep reading `stage` while it migrates. Owns `domain/task.ts`,
      `domain/waiting-for.ts`, `domain/workflows/**`.
- [ ] P3. Database: columns `phase`, `step` with a backfill from `stage` / `resume_stage` and a
      `CHECK` per column; `stage` kept and written for one release; the append-only `stage_changed`
      journal is not rewritten, readers accept both shapes. Owns `engine/drizzle/**`,
      `infrastructure/db/**`.
- [ ] P4. Engine consumers, one by one, each test-green: `status-card`, `resume-after-restart`,
      `start-run`'s `NOT_STARTABLE`, `waiting-for`, `get-overview`, the watcher's `PR Open` rules (with
      ADR-0024's rules, which this task should wait for), `answer-question`, `ask-owner`, `retry-stage`.
- [ ] P5. Contracts and web: `shared/src/api/{tasks,overview,threads,sessions,usage-report}.ts` gain
      `phase`/`step` beside `stage`; `StageBadge`, `StageStepper`, `threadFilters`, `TaskHeader`,
      `ArtifactTabs` move over; then `stage` is dropped in a later release. Owns `shared/src/api/**`,
      `web/src/**`.

Measured on the tree: `TaskStage` appears in 29 non-test files, `resumeStage` in 6, in `shared/`,
`engine/` and `web/`; `stage` is persisted and in the SSE and REST contracts.

## Acceptance: what a `review` kind costs (ADR-0023, "What adding a kind costs afterwards")

After Tasks A–E, the work for `review` is: (1) `'review'` in `shared/src/enums.ts`; (2) new
`domain/workflows/review.ts`; (3) one line in `domain/workflows/index.ts`; (4) new
`agent/prompts/workflows/review.md`; (5) a row in `agent/prompts/dispatcher.md`; (6) a generated
migration `engine/drizzle/0005_*` (+ snapshot, journal) — which, if the owner accepts ADR Q2, also
drops the `CHECK` so no later kind needs one; (7) one flow test. If implementing it requires editing
any file in `application/`, `infrastructure/` or `presentation/`, report which and why: the design has
a gap and this plan is not done.

## Order

A first, alone. Then B and C in parallel (their paths are disjoint; B owns `application/`, C owns the
two adapter directories). When both are green, D and E in parallel (D owns `agent/`, E owns the
architecture test and the last cleanups) — D only with the owner's yes. F and P are separate decisions.
Nothing is committed; the owner reviews the working tree.

## Review focus

1. Any argv, env, `mcp.json` or first-message byte that differs for `build` or `ui_check` — the goldens
   exist to make this impossible; check they were written before the refactor.
2. A `ui_check` run reaching a tool outside its list: through the MCP child (C5), the HTTP route (C6)
   or a use case (B1).
3. The trust gate: a `pull-request-head` workflow with a browser stage and no `trusted-head`.
4. A definition field with a default or an optional marker — there must be none.
5. An adapter importing a definition instead of reading the profile.
6. The architecture rule: that it fails on a real new branch, and is not satisfied by luck (comments
   stripped, the kind list read from `@jarvis/shared`, not copied).
7. Prompt text changed beyond a move (Task D).
