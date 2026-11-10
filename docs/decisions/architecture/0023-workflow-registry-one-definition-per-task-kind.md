---
status: proposed
date: 2026-11-09
decision-makers: [] # owner: asked for a workflow registry — one definition per task kind, the engine reads it instead of branching (2026-11-09); drafted by Claude
scope:
  [
    'engine/src/domain/workflows/**',
    'engine/src/domain/task.ts',
    'engine/src/application/workflows/**',
    'engine/src/application/run-identity.ts',
    'engine/src/application/ports/agent-runner.ts',
    'engine/src/application/runs/**',
    'engine/src/application/tasks/**',
    'engine/src/application/ui/**',
    'engine/src/infrastructure/claude/**',
    'engine/src/presentation/mcp/**',
    'engine/src/presentation/http/routes/agent.ts',
    'engine/src/architecture.test.ts',
    'shared/src/enums.ts',
    'agent/prompts/**',
  ]
supersedes: []
superseded-by: []
---

# ADR-0023: A task kind is one definition in a registry — the engine reads it instead of branching on the kind

Amends ADR-0018 (how `ui_check` is told apart from `build`) and ADR-0020 (how a third role is
added). Builds on ADR-0002 (where the definitions may live) and ADR-0004 (who may call which tool).

## Context and Problem Statement

ADR-0018 added a second task kind, `ui_check`, by branching on `task.kind` wherever the two differ.
Reading the working tree (the file and line references below are from 2026-11-09/10; the
agent-memory code has landed in it, the engine-side checks have not) shows what that cost: the kind
is named in **23 non-test files** (19 in `engine/src`, 2 in `shared/src`, 2 in `agent/prompts`;
`web/` knows nothing of it), **9 of them as a real conditional** and the rest as plumbing, defaults,
schemas and prose. A third thing is already designed (the `retro` run role,
ADR-0020, proposed, not built) and its own ADR lists "a third role threads through the role
plumbing" as a cost. More kinds are wanted: reviewing someone else's pull request, CI triage,
spec-only tasks, scheduled tasks.

If the cost of a kind stays "visit every layer and find the places by memory", each new kind repeats
the `ui_check` work, and the places that carry a **security property** — no `GH_TOKEN`, no project
settings from a foreign head, the owner's approval before a foreign head runs — are exactly the ones
a new kind would forget.

### The inventory: everything the engine decides by kind today

Verified by reading the working tree. Rows 1–11 decide something; 12–17 hold the kind's name or
mirror a decision.

| #   | Where                                                                                        | What is decided there                                                                                                                                                                                                | Moves to (field)                               |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | `domain/task.ts:81-98` (`UI_CHECK_TRANSITIONS`, `transitionsOf`)                             | Which of two 12-row transition tables applies. In the `ui_check` table five rows (`Spec Review`, `Implementing`, `Verifying`, `PR Open`, `Fixing`) allow only the exits: dead stages.                                 | `transitions`                                  |
| 2   | `domain/task.ts:176`, `application/tasks/create-task.ts:45`                                  | The default kind, spelled `'build'` twice.                                                                                                                                                                           | `DEFAULT_KIND`                                 |
| 3   | `application/tasks/create-task.ts:96-122`                                                    | `pr` is refused for `build` and required, parsed and repo-checked for the other kind; two error texts.                                                                                                               | `pullRequest`                                  |
| 4   | `create-task.ts:68-71` and `application/tasks/worktree-for.ts:14`                            | Which worktree: own branch `jarvis/<id>` or the PR head `jarvis-check/<id>`. Two places that must agree; the second exists because the first once disagreed (its doc comment says asking for the wrong one fails). | `workspace`                                    |
| 5   | `infrastructure/git/git-worktree-manager.ts:116-135`, port `ports/worktree-manager.ts:14`    | What the engine precomputes into the worktree before the run: `.jarvis/changed-files.txt` and `diff.patch`, only inside `createForPullRequest`.                                                                      | part of `workspace: 'pull-request-head'`       |
| 6   | `application/runs/start-run.ts:200`, `run-prompt.ts:6-12,53-56,68-70`                        | Whether the run context carries the PR line, the criteria sources and the wrapped PR text (ADR-0017). Three typed optional fields exist only for one kind.                                                            | `contextBlocks`                                |
| 7   | `start-run.ts:179,352`, `ports/agent-runner.ts:32`, `infrastructure/claude/claude-cli-runner.ts:118` | Plumbing only: the kind is copied into the prompt, into `RunSpec.taskKind` and into the child-env options so that rows 8–10 can test it.                                                              | replaced by `RunSpec.profile`                  |
| 8   | `infrastructure/claude/run-args.ts:50`                                                       | Settings sources: `user` for a `ui_check` run (a foreign head's `.claude/settings.json` must not vote), `project,local` otherwise.                                                                                   | `settingSources`                               |
| 9   | `run-args.ts:18-31,72-77`                                                                    | Tools denied for a `ui_check` worker: the built-ins `Bash`, `Edit`, `NotebookEdit`, and (ADR-0021) the four memory-write MCP tools, hidden by a second list.                                                          | `deniedBuiltinTools`, `tools`                  |
| 10  | `infrastructure/claude/child-env.ts:74`                                                      | Whether the child gets `GH_TOKEN`. (Disappears for every worker when "engine-side checks and PR" lands; see Sequencing.)                                                                                              | `githubToken` — only if that change slips      |
| 11  | `application/ui/trust-pull-request-head.ts:44`                                               | Whether the owner-approval gate on running a PR head applies: it returns `trusted` at once for any other kind.                                                                                                        | `gates.beforeDevServer`                        |
| 11b | `application/profile/memory-support.ts:27-31` (`requireBuildTask`)                           | ADR-0021: the memory-write use cases refuse any task that is not `build`. A second statement of row 9's memory list, in the application layer.                                                                       | the run's `tools` (one helper)                 |
| 12  | `application/tasks/report-stage.ts:13`, `shared/src/mcp.ts:89`                               | Who closes the task. No code: the outcome of row 1 (`Reviewing → Done` exists only in the `ui_check` table). Two comments explain it.                                                                                | stays row 1; comments made kind-agnostic       |
| 13  | `infrastructure/db/schema.ts:54,74`, `drizzle/0004`, `db/task-repository.ts:15`              | The persisted domain of the kind: a column, a `CHECK` generated from `TASK_KINDS`, and an unchecked `as TaskKind` cast.                                                                                              | stays (Q2)                                     |
| 14  | `shared/src/enums.ts:25`, `shared/src/mcp.ts:50-52`                                          | The wire domain of the kind: `TaskKindSchema` and the `create_task` input.                                                                                                                                           | stays — one line per kind                      |
| 15  | `presentation/mcp/server.ts:10`                                                              | The `create_task` description teaches the dispatcher when to pass `ui_check`.                                                                                                                                        | generic text; routing stays in `dispatcher.md` |
| 16  | `agent/prompts/worker.md:29,231-306`, `agent/prompts/dispatcher.md:16,48`                    | One prompt section per kind, picked by the model from a `taskKind:` line; routing rows for the dispatcher.                                                                                                           | `promptSection`; the dispatcher rows stay      |
| 17  | `application/testing/build-test-app.ts:52-60,194-205`, `testing/create-task-flow.ts:14-24`   | Test-only: `UI_CHECK_PATH_TO` repeats the transition table to seed a task at a stage.                                                                                                                                | derived from `transitions`                     |

Two more things behave per kind without naming it, and a definition has to own them too:

- **Stages.** `application/ui/start-dev-server.ts:29` allows the dev server in `Reviewing` only;
  `application/tasks/status-card.ts:14-31` has one fixed list of six steps and a stage-to-step map
  that `ui_check` borrows (it shows "spec" and "implementing" as steps it never takes). → `browserStages`,
  `progress`.
- **Roles.** `infrastructure/claude/run-files.ts:209-212` gives the browser to `role === 'worker'`
  when `ui.enabled`; a kind without a browser would still get it. → `browser`.

What is **not** per kind and stays global: the stage vocabulary (`TaskStage`), `NOT_STARTABLE`,
`WORKER_STAGES` in recovery, `waitingFor`, the watcher's `PR Open` rules, `ReportStage`'s accepted
stages. They key on stage names, not kinds; today both kinds share them because `ui_check` never
reaches `PR Open`. They are the subject of the optional stage/phase split below.

The agent-memory work (`docs/plans/agent-memory.md`, ADR-0021) was the first feature after
`ui_check`, and it re-grew the same branches within a day: rows 9 and 11b are its. The memory tools
are hidden in `run-args.ts` and refused again in `requireBuildTask`; two lists, two layers, one
intent. That is the pattern this ADR removes.

## Decision Drivers

- **Behaviour-preserving for `build` and `ui_check`.** The 920 engine tests are the safety net; no
  database migration unless unavoidable.
- **A new kind is a handful of files**, and none of them in `application/` or `infrastructure/`
  unless the kind needs a genuinely new capability.
- **Security properties fail closed.** A definition cannot omit "which settings sources load" or "no
  token"; a kind that stands on a foreign head cannot omit the trust gate.
- **The onion holds** (ADR-0002): domain pure, `shared` for wire contracts, adapters unaware of
  business rules.
- **Separable from the stage redesign.** The registry must pay for itself without touching the
  persisted `stage`.
- **It also answers "a role without a task"** (the `retro` of ADR-0020) without a second mechanism.

## Considered Options

1. **A registry of declarative definitions in the domain** — plain data plus small pure functions,
   one file per kind — with the engine's *capabilities* (a workspace, a context block, a gate)
   implemented once in `application/` and *named* by the definition.
2. **Strategy objects**: an `interface Workflow` whose methods take ports (`prepareWorkspace(worktrees)`,
   `describe(codeHost)`), one class per kind in `application/`.
3. **Centralise the `if`s**: keep branching, but behind predicates in one file (`isUiCheck(task)`).
4. **Definitions in `shared`** so web, engine and the MCP child all import the same object.
5. **Definitions as data the owner edits** (`jarvis.config.json` or a file in the agent plugin).

## Decision Outcome

**Option 1.**

### Where the definitions live

| Piece                                                                   | Layer / path                                                             | Why                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskKindSchema` (the id list)                                          | `shared/src/enums.ts` — unchanged                                        | It is a wire contract (`create_task`) and it types the persisted column. One line per kind stays here.                                                                                                                                                           |
| `WorkflowDefinition`, one file per kind, the registry, `RunProfile`     | `engine/src/domain/workflows/{types,build,ui-check,index}.ts`            | They are data and pure functions over `TaskStage`. The domain rule allows `import type` from `@jarvis/shared`, which is all they need (`TaskKind`, `TaskStage`, `ToolName` are types). `transitions` already lives in the domain; it moves one directory down. |
| Resolvers and capability blocks (`profileFor`, `prepareWorkspace`, context blocks, gates) | `engine/src/application/workflows/**`                                    | They use ports (`WorktreeManager`, `CodeHost`, permissions) and runtime values from `shared` (`toolsByRole`). Application may.                                                                                                                                   |
| Everything adapter-side                                                 | reads `RunSpec.profile` and `RunIdentity.tools`; **imports no definition** | `run-args`, `child-env`, `run-files`, the MCP child and the HTTP route do not know a kind exists. They obey plain data the application computed. This is what removes rows 7–10 for good.                                                                       |

The registry is `Readonly<Record<TaskKind, WorkflowDefinition>>`. Adding an id to `TaskKindSchema`
without adding its definition **does not compile**. There is no reverse direction: the engine does
not generate the enum from the registry, because `shared` cannot import the engine and the dispatcher's
`create_task` schema must stay a wire contract.

### The shape

Every field is required. There are no defaults: a definition that forgets a security-relevant field
fails the typecheck instead of inheriting a permissive value.

```ts
// engine/src/domain/workflows/types.ts — domain: `import type` from shared only
import type { TaskKind, TaskStage, ToolName } from '@jarvis/shared';

export type SettingSource = 'user' | 'project' | 'local';

/** Implemented once in application/workflows/context-blocks.ts; the definition only names them. */
export type ContextBlockId = 'pull-request';
/** Implemented once in application/workflows/gates.ts. */
export type GateId = 'trusted-head';

export interface ProgressSpec {
  readonly steps: readonly string[];
  /** Index of the step a stage is working on; `steps.length` means everything is done. */
  readonly activeStep: Readonly<Record<TaskStage, number>>;
}

export interface WorkflowDefinition {
  readonly id: TaskKind;
  /** One line, for logs and error messages. */
  readonly summary: string;

  // 1. Lifecycle ─ rows 1, 12, 17
  readonly transitions: Readonly<Record<TaskStage, readonly TaskStage[]>>;
  readonly progress: ProgressSpec; // the status card
  /** Stages in which `start_dev_server` is allowed; empty for a kind with no browser. */
  readonly browserStages: readonly TaskStage[];
  readonly retroEligible: boolean; // ADR-0020: only a `build` task triggers a retro
  /** ADR-0024: a watch source (schedule, issue, red `main`) may start this kind without a person. */
  readonly startableByWatch: boolean;

  // 2. Creation ─ rows 2, 3, 4, 5
  readonly pullRequest: 'forbidden' | 'required';
  /**
   * `own-branch`: `jarvis/<id>`, cut from the base branch.
   * `pull-request-head`: `jarvis-check/<id>` on the PR's head, with the engine's precomputed
   * `.jarvis/changed-files.txt` and `.jarvis/diff.patch`. The precompute is part of the workspace
   * on purpose: there is exactly one, it cannot run without the head, and a second one is the
   * moment to split it out.
   */
  readonly workspace: 'own-branch' | 'pull-request-head';

  // 3. The run ─ rows 6–11, the browser, the prompt
  /** The Jarvis MCP tools the run may call. Must be a subset of `toolsByRole.worker`. */
  readonly tools: readonly ToolName[];
  /** Built-in Claude Code tools denied with `--disallowedTools`. */
  readonly deniedBuiltinTools: readonly string[];
  readonly settingSources: readonly SettingSource[];
  readonly browser: boolean; // Playwright MCP in mcp.json, subject to `ui.enabled`
  readonly contextBlocks: readonly ContextBlockId[];
  readonly gates: { readonly beforeDevServer: readonly GateId[] };
  /** File under `agent/prompts/workflows/` appended after `worker.md`: 'build' | 'ui-check'. */
  readonly promptSection: string;
}

/** What an adapter needs to start one `claude` process; plain data, no kind in it. */
export interface RunProfile {
  readonly tools: readonly ToolName[];
  readonly deniedBuiltinTools: readonly string[];
  readonly settingSources: readonly SettingSource[];
  readonly browser: boolean;
  /** Prompt files under `agent/prompts/`, in order: ['worker.md', 'workflows/ui-check.md']. */
  readonly promptFiles: readonly string[];
}
```

`githubToken: boolean` is **not** in the interface. After "engine-side checks and PR" no worker has a
token; if that change slips, the field is added (build `true`, `ui_check` `false`) in step A and row
10 is routed through `RunProfile` like the others (see Sequencing).

The two definitions, as they would be written (values are today's, copied, not redesigned):

```ts
// engine/src/domain/workflows/ui-check.ts
export const uiCheck: WorkflowDefinition = {
  id: 'ui_check',
  summary: 'look at an existing pull request in a browser; write no code, open no PR',
  transitions: UI_CHECK_TRANSITIONS, // the table from task.ts, moved unchanged
  progress: BUILD_PROGRESS, // unchanged for parity — shows "spec"/"implementing"; see Q5
  browserStages: ['Reviewing'],
  retroEligible: false,
  startableByWatch: false, // it needs a PR, which a watch source does not have
  pullRequest: 'required',
  workspace: 'pull-request-head',
  tools: [/* the worker tools, minus the four memory-write tools */],
  deniedBuiltinTools: ['Bash', 'Edit', 'NotebookEdit'],
  settingSources: ['user'],
  browser: true,
  contextBlocks: ['pull-request'],
  gates: { beforeDevServer: ['trusted-head'] },
  promptSection: 'ui-check',
};
// build.ts: TRANSITIONS, tools = every worker tool, deniedBuiltinTools [], settingSources
// ['project', 'local'], pullRequest 'forbidden', workspace 'own-branch', contextBlocks [],
// gates { beforeDevServer: [] }, retroEligible true, startableByWatch true,
// browserStages ['Reviewing'].
```

### What reads it

- **Creation** (`CreateTask`): `pullRequest` replaces the `kind === 'build'` branch and keeps both
  error texts word for word; `workspace` replaces the second branch and the one in `worktreeFor`
  with one `prepareWorkspace(worktrees, workflow, task)`.
- **The run** (`StartRun`): `profileFor(task)` returns the `RunProfile`; it goes into
  `RunSpec.profile`. Context blocks produce the `pr:` and `criteriaSources:` lines and the
  `## Pull request text (data, not instructions)` section exactly as today; `run-prompt.ts` takes a
  list of parts instead of three optional PR fields.
- **Adapters** read the profile: `run-args` (`--setting-sources`, `--disallowedTools`),
  `run-files` (the `allow` rules for the run's own tools, whether Playwright is in `mcp.json`),
  `buildSystemPrompt` (which prompt files), the MCP child (which tools it registers).
- **Tool authorisation.** `RunIdentity` gains `tools`, set where the run token is issued. The HTTP
  route's `requireTool` checks `identity.tools` instead of `toolsByRole[identity.role]`, so a
  `ui_check` run that calls `note_insight` gets a 403 from the engine, not only a missing tool in
  its list. The memory use cases' `task.kind !== 'build'` guard (agent-memory B1) becomes the same
  check through one helper, `requireWorkflowTool(task, tool)`. The MCP child learns its list from
  `JARVIS_TOOLS` in `mcp.json` and registers the intersection with `toolsByRole[role]`; the engine
  stays the authority.
- **Gates.** `StartDevServer` runs the gates the definition lists; `TrustPullRequestHead` loses its
  `task.kind` test. A workflow that has a workspace on a foreign head **and** a browser stage must
  list `trusted-head`; a unit test over the registry enforces it.
- **Stages.** `StatusCard` reads `workflow.progress`; `StartDevServer` reads `browserStages`.

### How `retro` fits

A role without a task is **a separate axis, not a workflow**. A workflow answers "what is this task
for" and exists only through a task row (`kind`); a role answers "who is calling" and exists for
every run, including the dispatcher's and the retro's, which have no task kind. Forcing the retro into
`TaskKind` would invent a task that is never created, with transitions nobody uses.

What the two axes share is the *output*: a `RunProfile`. A worker run's profile is its workflow's;
a role without a workflow has a profile of its own (`ROLE_PROFILES`, optional Task F in the plan:
the dispatcher's allow/deny lists now in `run-args.ts` and `run-files.ts`, and later the retro's).
Adapters read a profile and never ask which axis it came from. That is why the retro stops being a
"third role threads through the plumbing" and becomes one row.

**What ADR-0020 would need changed** (not redesigned here):

1. "Bad: a third role threads through `RoleSchema`, `toolsByRole`, `run-args`, `child-env`, …" is
   replaced: `RoleSchema`, `toolsByRole`, one `ROLE_PROFILES` row and the scheduler; `run-args`,
   `child-env` and `run-files` get no `retro` case.
2. "Only `build` tasks trigger retros" is read from `workflow.retroEligible`; without it the retro
   would add a ninth `kind ===` branch and fail the architecture test below.
3. It does not mention that `sessions_role_check` and `runs_role_check` are `CHECK`s generated from
   `ROLES` (`infrastructure/db/schema.ts:139,173`): adding a role needs a migration. Say so (Q2
   covers both).
4. The retro's tools, denied built-ins, `GH_TOKEN`-less env and cwd (the artifacts directory) are
   written as its `RoleProfile`, not as cases in three adapters.

### The optional split: engine phase versus workflow step

**Not part of this decision; a separate owner decision, Q1.** Today `stage` is one vocabulary that
mixes two things: where the *engine* is with the task (running, waiting for the owner, waiting for an
external event, finished — `Blocked`, `Spec Review`, `PR Open`, `Failed` in part) and where the
*workflow* is (`Implementing`, `Verifying`, `Reviewing`). Splitting them would remove `Blocked` plus
`resumeStage` and the dead stages of `ui_check`.

Cost, measured on the tree: `TaskStage` is used in **29 non-test files** across `shared/`, `engine/`
and `web/`; `resumeStage` in 6; `stage` is persisted (`tasks.stage`, `tasks.resume_stage`, a `CHECK`
from `TASK_STAGES`, the append-only `stage_changed` journal that must stay readable); it is in the
SSE and REST contracts (`shared/src/api/*`) and drives `StageBadge`, `StageStepper`, the thread
filters and the task header. A rename needs a data migration with a backfill, a compatibility
projection (`stage` derived from `phase + step`) for at least one release, and web changes.

Risk: high and spread; benefit: it matters only when a kind wants a step `build` does not have. The
registry already hides the dead stages (a definition lists only its legal transitions and its own
`progress`), so most of the visible benefit arrives without it.

**Recommendation: not now.** Do the registry; build one or two new kinds on it; split when a kind
actually needs its own step names. It is Task P in the plan, separable, not a precondition of any
other task, and the registry is written so that P replaces `transitions` and `progress` inside the
definitions and nothing else.

### What adding a kind costs afterwards: `review`

A hypothetical `review` kind: it reads an existing PR's diff, runs the `reviewer` subagent, and
offers a PR comment — `ui_check` without the browser. Stages stay `Context → Reviewing → Done`.

| #   | File                                                      | Change                                                                                                                                                                                                    |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `shared/src/enums.ts`                                     | `'review'` in `TaskKindSchema` (one line). The typecheck now fails until 2 and 3 exist.                                                                                                                   |
| 2   | `engine/src/domain/workflows/review.ts` (new, ~30 lines)  | `transitions: LOOK_AT_A_PR_TRANSITIONS` (ui-check's table, exported and shared), `pullRequest: 'required'`, `workspace: 'pull-request-head'`, `tools` written out tight from the start — `report_stage`, `ask_owner`, `log_note`, `post_update`, `comment_on_pr`, `approve` (no `open_pr`, no `submit_spec_for_approval`: the point of an explicit list); `deniedBuiltinTools: ['Bash','Edit','NotebookEdit']`, `settingSources: ['user']`, `browser: false`, `browserStages: []`, `contextBlocks: ['pull-request']`, `gates: { beforeDevServer: [] }`, `retroEligible: false`, `startableByWatch: false`, `promptSection: 'review'`. |
| 3   | `engine/src/domain/workflows/index.ts`                    | One entry in the registry map.                                                                                                                                                                            |
| 4   | `agent/prompts/workflows/review.md` (new)                 | What a review task does: read the prepared diff, call `reviewer`, write the report, `comment_on_pr`, `report_stage Done`.                                                                                  |
| 5   | `agent/prompts/dispatcher.md`                             | One routing row: "review this PR" → `create_task` with `kind: "review"` and `pr`.                                                                                                                         |
| 6   | `engine/drizzle/0005_*.sql` + `meta/0005_snapshot.json` + `meta/_journal.json` | Generated. Needed once for the `CHECK` on `tasks.kind`; if Q2 is accepted this migration also drops that `CHECK`, and the next kind needs none. |
| 7   | `engine/src/domain/workflows/review.test.ts` or a flow test | One scenario: create → report → Done. The registry-wide contract tests (tools subset, gate rule, transitions legal) pick the new definition up by iterating the registry; no edit there.                  |

**Five hand-written files, one generated migration, one test. Nothing in `application/`,
`infrastructure/`, `presentation/` or `web/`.** The `reviewer` subagent, `comment_on_pr` with its
permission card, the PR workspace and the PR context block all exist and are reused by name. If the
review needed something new — say its own context block — that block is one file in
`application/workflows/context-blocks.ts` plus its id in the union, and it is then available to every
later kind.

Not counted: the spec and ADR for the kind, which are documents, and the `docs/` index row.

### Why not the others

- **(2) Strategy objects** put behaviour with ports into the definition. Then `run-args` (an adapter)
  and the MCP child (another process) cannot read it without importing application code, each kind
  becomes a class to test with fakes instead of a table to assert, and logic migrates into
  definitions over time. The split chosen here keeps the definition *describable*: a test can print
  every field of both kinds and compare them with the old behaviour.
- **(3) Centralised predicates** leave one predicate per question and one call site per predicate;
  a new kind is still N edits, and nothing forces the author to answer a question they did not know
  existed.
- **(4) Definitions in `shared`** would carry settings sources, gates and denied tools — engine
  business rules — into the package the web app also builds from. The web does not use the kind
  (verified: `grep ui_check|TaskKind web/src` is empty). The only cross-process need, the tool
  list for the MCP child, is met by an environment variable.
- **(5) Owner-editable definitions** are the tempting one, and wrong here. A workflow carries the
  properties ADR-0018 deliberately has **no setting** for (the trust gate, no project settings from a
  foreign head). The dispatcher can already patch `jarvis.config.json` through `update_config`
  (ADR-0013); a definition in config would let a prompt injection into the dispatcher widen a
  workflow's tools. Definitions are code, reviewed like code.

### Sequencing this decision assumes

1. **Agent memory** (ADR-0021) lands first and changes `shared/src/mcp.ts`, `run-args.ts`,
   `start-run.ts`, `run-prompt.ts`, `agent-tools.ts`, `worker.md`. The plan starts from that tree and
   *migrates* its kind-keyed sites (rows 9 and 11b) rather than working around them.
2. **Engine-side checks and PR** (ADR-0022, written 2026-11-10 and read for this ADR) lands second:
   `report_checks` and `report_pr` leave the worker's tools, `open_pr` arrives, no worker gets
   `GH_TOKEN`, and `githubToken` leaves `buildChildEnv`'s options. Row 10
   disappears with it, and the plan's child-env step reduces to "confirm `child-env.ts` no longer reads
   the kind". If it slips, the plan has a marked alternative per affected step.
3. **This registry.**
4. **The generalised watcher** (ADR-0024), in which a watch source starts or wakes a workflow. Its
   ADR asks this one for exactly one thing — "which workflows a watch may start" — and that is the
   `startableByWatch` field above (`build` yes, `ui_check` no; `ci_triage` is a future workflow id in
   its examples). Its other need, a per-workflow rule for "which event wakes which stage", is not
   pre-built: the watcher's `PR Open` logic (`poll-pull-requests.ts`, `handle-code-host-change.ts`,
   `waiting-for.ts`, `get-overview.ts`) is the first set of such rules, and `WorkflowDefinition` gains
   a field for them when ADR-0024 is implemented. An unknown or non-startable `workflow` in a watch
   rule fails startup (its LIM-02); that check reads the registry.

## Consequences

- Good: a new kind is a definition file, one enum line, one prompt file and, once, a migration. The
  four things a kind most easily gets wrong — token, settings sources, denied tools, the trust gate —
  are required fields with tests behind them.
- Good: adapters stop knowing business concepts. `run-args`, `child-env`, `run-files` and the MCP
  child read a profile; rows 7–10 and 15 disappear.
- Good: tool authorisation becomes per kind in the engine (the route), not only in what the MCP child
  registers. Today a `ui_check` worker can call `submit_spec_for_approval` and gets an
  `illegal_transition`; with an explicit `tools` list the question can be tightened later (Q4).
- Good: the `retro` role and a future kind share one adapter contract (`RunProfile`).
- Bad: indirection. To learn what a `ui_check` run gets you now read a definition, `profileFor` and a
  context block instead of finding a few `if`s. The answer is in one place, but it is not on the line
  you were looking at.
- Bad: capability ids are strings bound to implementations (`'trusted-head'`, `'pull-request'`). A
  `Record<GateId, Gate>` and `Record<ContextBlockId, Block>` make an unimplemented id a compile error,
  but a definition can still name the wrong block.
- Bad: the `tools` list duplicates `toolsByRole.worker` by hand for each kind. Tripwire tests
  (build equals the worker set; every worker tool appears in some workflow) keep them honest; they do
  not make the duplication go away.
- Bad: the enum, the column's `CHECK` and the migration are still per-kind touch points. One migration
  per kind until Q2 is accepted.
- Bad: stages stay a global vocabulary. A kind that needs a step `build` lacks (`Triaging`) still
  touches `shared` (`TaskStageSchema`), the `CHECK`, `StageBadge` and `StageStepper`. This is what
  the optional phase split removes, and why it is a decision, not a leftover.
- Bad: moving the `ui_check` and `build` instructions out of `worker.md` into per-workflow files
  changes what the model reads, and a prompt change is not covered by a unit test. It is the last
  step of the plan and is compared on a real run before it counts as done (Q3).
- Bad: `ui_check`'s status card keeps showing "spec" and "implementing" as steps it never takes,
  because `progress` is copied for parity. The field makes the fix a one-liner later (Q5).

## Confirmation

- RULE: no production code outside `engine/src/domain/workflows/` names a task kind. A string
  literal equal to a value of `TASK_KINDS` is a violation, and so is the identifier `taskKind` (the
  `taskKind: <id>` line printed into the run context is a template string and is not an identifier).
  The allowed exceptions are listed in the test with a reason each: `infrastructure/db/schema.ts`'s
  column default, and the CI check named `"build"` in the `application/testing/pr-open-flow.ts` fixture.
  Comments are stripped first, with the scanner's existing `stripComments`.
  CHECK: `engine/src/architecture.test.ts`, new `describe('architecture: ADR-0023 workflows')`; the
  scan reads `TASK_KINDS` from `@jarvis/shared`, so a new kind is covered at once. Synthetic samples
  (`task.kind === 'ui_check'`, `case 'build':`, `{ kind: 'review' }` in an application file) must be
  reported, in the style of the file's existing "the rules catch violations" block.
- RULE: the registry is exhaustive over `TaskKind`.
  CHECK: the type `Readonly<Record<TaskKind, WorkflowDefinition>>`; a test iterating `TASK_KINDS`.
- RULE: nothing changed for `build` and `ui_check`.
  CHECK: parity tests written **before** the refactor against the old constants and kept after:
  `transitions` equal `TRANSITIONS` and `UI_CHECK_TRANSITIONS` row by row; `buildRunArgs` argv for both
  kinds and both roles equals a golden captured from the old code; the first message of a `ui_check`
  run equals a golden; the full existing engine suite passes unchanged.
- RULE: every workflow's `tools` is a subset of `toolsByRole.worker`; `build`'s is equal to it; every
  worker tool appears in at least one workflow; `startableByWatch` is true for `build` and false for
  `ui_check`; `ui_check` has none of `note_insight`, `confirm_insight`, `contradict_insight`,
  `remember_owner`.
  CHECK: `domain/workflows/workflows.test.ts` (runtime `toolsByRole` is imported in the test only).
- RULE: a workflow with `workspace: 'pull-request-head'` and a non-empty `browserStages` lists
  `trusted-head` in `gates.beforeDevServer`.
  CHECK: the same test file.
- RULE: a run can only call the tools of its profile, enforced by the engine.
  CHECK: route test — a `ui_check` run's token calling `note_insight` is refused with 403; a `build`
  run's succeeds. MCP test — `createJarvisMcpServer` with `JARVIS_TOOLS` registers exactly that list
  and never one outside `toolsByRole[role]`.
- RULE: adapters read the profile only. `infrastructure/claude/**` and `presentation/**` import no
  file from `domain/workflows/` and `application/workflows/`.
  CHECK: the architecture test (a path rule next to the existing layer rules).
- RULE: the refactor adds no migration.
  CHECK: review — no new file under `engine/drizzle/` in the registry's tasks. (The `review`
  example's migration belongs to that kind, not to this change.)
- RULE: the domain stays pure.
  CHECK: the existing ADR-0002 domain rules; the new directory is inside `domain/`.

## More Information

- Plan: `docs/plans/workflow-registry.md`.
- Related: ADR-0018 (the `ui_check` kind), ADR-0019 (its environments), ADR-0020 (the `retro` role),
  ADR-0021 (memory; its kind-keyed sites are migrated by this plan), ADR-0022 (engine-side checks and
  PR; removes row 10), ADR-0024 (the generalised watcher).
- **Open questions, for the owner:**
  - **Q1.** Do the engine-phase / workflow-step split? Recommendation: **no, not now** (Task P stays
    unscheduled); revisit when a kind needs a step `build` does not have.
  - **Q2.** Drop the `tasks_kind_check` `CHECK` (and, with the retro, `runs_role_check` and
    `sessions_role_check`) in the migration of the first new kind, and validate on the way in with
    `TaskKindSchema.parse` in `task-repository.ts`? Recommendation: **yes**; the registry already is
    the list of valid kinds, a second list in SQL only costs a migration per kind. Not part of the
    refactor.
  - **Q3.** Split `worker.md` into a common file plus `workflows/build.md` and `workflows/ui-check.md`
    (Task D)? Recommendation: **yes, last**, with the same task replayed on the fake and one real run
    before and after. If not, drop `promptSection` and a new kind adds a section to `worker.md`.
  - **Q4.** Tighten `ui_check`'s `tools` beyond the memory tools — drop `open_pr` (after ADR-0022),
    `submit_spec_for_approval` and anything else it can never use legally? Today it can call them and
    is refused by the transition table. Recommendation: **yes, as its own small change after parity
    is proven**; it changes the error the model sees, so it is not part of a behaviour-preserving
    refactor. The same change can narrow the `allow` rules of its `settings.json` to the profile.
  - **Q5.** Give `ui_check` its own `progress` (context → review → report)? Recommendation: **yes,
    later**; the web app renders the labels, so check `StageStepper` first.
  - **Q6.** Move the dispatcher's allow/deny lists into `ROLE_PROFILES` now (Task F) or together with
    the retro? Recommendation: **with the retro**; it is a pure move, and it is worth doing once the
    second role profile exists to prove the shape.
- Not decided here: `WorkflowDefinition` growing wake rules for ADR-0024; dispatcher-side routing
  between kinds beyond the prompt rows; exposing `kind` in the task DTO for the web app.
