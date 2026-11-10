---
status: draft
date: 2026-10-26
owner: Ivan Lapa
plan: TBD — after UI design and engine spec
---

# Abstract Project Spec — Jarvis: a personal agent from task to PR

Oct 26, 2026 · @Ivan · Updated 2026-11-08: CON-03/04/10 and "Out of scope" aligned with the
accepted ADR-0012/0013/0015/0016 (server, multiple repositories, learned facts, Infisical).

## Goal and boundaries

**Jarvis** is a personal AI development agent that runs on the owner's laptop through their
Claude Code subscription. The owner submits a task in chat, and Jarvis carries it to a verified
pull request and shepherds the PR until the conditions are met: CI is green, reviewer comments
are fixed, and the summary has been sent.

The prototype serves two purposes:

- **The webinar.** An end-to-end demonstration of "from task to verified PR" (webinar concept:
  `docs/webinar/webinar-concept.md`, v2).
- **A foundation for the course and experiments.** A participant can run the PoC on their own
  subscription and take apart every component.

The main flow:

1. The owner writes a task in chat with links to the design (Claude Design) and materials
   (Notion, Google Docs). Each new message opens a thread, and all further conversation about the
   task happens in it.
2. Jarvis gathers context, writes a specification and a plan, and sends them to the thread for
   confirmation.
3. After confirmation, it implements the feature on a separate branch, runs the checks, performs
   a review, and opens a draft PR from its own GitHub account.
4. It watches CI and review, fixes failures and comments, and reports to the thread.
5. A human does the merge.

Iterations:

- **Iteration 1.** The Engine, a local database in Docker, and a web app that is both the chat
  with the agent and the admin UI: tasks, state, logs, run consoles, debugging. This also covers
  the SDD flow, connectors, CI supervision, and limits in the config.
- **Iteration 2.** Slack: the same chat through Slack threads. A message opens a thread, and the
  agent replies in that same thread.

This document describes **what** Jarvis must be able to do. Technical decisions live in
`docs/decisions/architecture/` (all `accepted`; the current list is in that directory's README),
the architecture description is in `docs/architecture/README.md`, and the design brief is in
`docs/specs/web-ui-design.md`.

## Constraints

- **CON-01. Subscription only.** All model calls go through the official `claude` CLI in print
  mode, logged in with the owner's account. No API key and no Agent SDK. If `ANTHROPIC_API_KEY`
  is present in the environment, Jarvis does not start (ADR-0003).
- **CON-02. One person.** One installation serves one owner on their subscription.
- **CON-03. One machine, no public access.** Jarvis runs on a single machine of the owner's: on
  the laptop or on a VPS reachable only through Tailscale (ADR-0016). The Engine, the web app,
  and Postgres (Docker) listen on loopback only; there is no public address.
- **CON-04. Repositories by allowlist.** The agent works with GitHub repositories from
  `repos.allow` or the owner's own repositories (`repos.allowOwnerRepos`), cloned on demand
  (ADR-0012); a task may carry its own `targetRepo`. Jarvis's own repository is a target only
  with `repos.allowSelf`, and then only through a pull request the owner merges. An `AGENTS.md` with the check
  commands (tests, lint, typecheck) and the dev-server command is the preferred contract. Without
  it the worker finds the check commands in the repository itself (package scripts, CI workflows,
  README), records them in `context.md` and shows them with the spec; it asks the owner only when
  it finds none. CI on GitHub Actions is still required.
- **CON-05. Free Slack (iteration 2).** The Slack bot runs on the free plan via Socket Mode and
  occupies one app slot.
- **CON-06. Max 5x plan.** We assume Claude Max at $100. The goal is to show that everything
  works without burning the whole limit. By default one worker at a time; the daily budget and
  run limits are set in the config (LIM-\*).
- **CON-07. No new paid services.** Nothing beyond the Claude Code subscription, GitHub, and free
  Slack.
- **CON-08. Live demo with a recording as backup.** The main flow runs live; edge cases can be
  shown from a recording.
- **CON-09. Separate GitHub account.** Jarvis pushes, opens PRs, and comments from its own
  account with its own token (ADR-0007).
- **CON-10. Secrets only in Infisical.** Infisical is the single source of secrets;
  `~/.jarvis/.env` is only a local fallback, and committed and deployed files contain no values
  (ADR-0015).
- **CON-11. Connectors via own MCP servers.** Notion and Google Docs are connected through MCP
  servers with tokens configured by Jarvis, not through claude.ai account connectors.

## Glossary

Names in the product are in English.

| Name                 | Meaning                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Jarvis`             | The agent as a whole: engine, web app, Claude runs, watcher, database                                                                 |
| `Owner`              | The agent's owner: submits tasks, answers questions, does the merge                                                                   |
| `Engine`             | A long-lived Node service. Holds state, launches Claude, watches GitHub, serves the API and live events to the web app                |
| `Thread`             | A conversation: the first `Owner` message and everything that happens in it afterwards. In Slack, a thread                            |
| `Message`            | A message in a thread: from the `Owner`, from Jarvis, or a system one (decision card, question, permission, status)                   |
| `Dispatcher`         | The Claude role that understands `Owner` messages, creates and manages tasks, and replies in the thread. Writes no code. One session per thread |
| `Worker`             | The Claude role that executes one `Task` in its own `Worktree`                                                                        |
| `Subagent`           | A specialized role inside the worker: `Context Researcher`, `Plan Verifier`, `Implementer`, `Reviewer`                                |
| `Run`                | One launch of the `claude` process for the dispatcher or a worker. Has an event stream, usage, and a result                           |
| `Console`            | The live view of a `Run` in the web app: model text, tool calls, results, errors                                                      |
| `Task`               | A unit of work: from the message to the end of PR follow-up                                                                           |
| `Task Stage`         | `Intake`, `Context`, `Spec Review`, `Implementing`, `Verifying`, `Reviewing`, `PR Open`, `Fixing`, `Done`, `Blocked`, `Failed`, `Cancelled` |
| `Worktree`           | A separate git working copy and a `jarvis/<task-id>` branch for one `Task`                                                            |
| `Watcher`            | The part of the engine that polls GitHub on a timer and turns CI and review changes into events without involving the model           |
| `SDD Artifacts`      | `context.md`, `spec.md`, `plan.md`, `tasks.md`, `result.md` in the task folder                                                        |
| `Task Journal`       | The chronology of the task's events in the database                                                                                   |
| `Profile`            | `SOUL.md` (the agent's role and principles) and `USER.md` (the owner's preferences)                                                   |
| `Agent Definition`   | A Claude Code plugin in the repository's `agent/` folder: `SOUL.md`, role prompts, subagents, skills, templates, permission rules     |
| `Jarvis Home`        | The `~/.jarvis` folder: `USER.md`, config, `.env`, MCP servers, worktrees, task artifacts                                             |
| `Config`             | The `~/.jarvis/jarvis.config.json` file: repository, limits, models, allowlist, connector boundaries. No secrets                      |
| `Connector`          | Access to an external source: Notion, Google Docs                                                                                     |
| `Design Source`      | A design from Claude Design, passed as a link or a handoff                                                                            |
| `Check`              | A local check: tests, lint, typecheck                                                                                                 |
| `Permission Request` | Claude's request for permission to run a tool, shown to the `Owner` in the thread                                                     |
| `Usage`              | An estimate of run cost in dollars based on CLI data. A brake, not an exact subscription meter                                        |

## Users and key scenarios

There is a single actor — the `Owner`. In iteration 1 they work in the web app, in iteration 2
also in Slack. Other people may be reviewers on GitHub but do not talk to Jarvis directly.

| ID    | Scenario                                                                    | Iteration |
| ----- | --------------------------------------------------------------------------- | --------- |
| UC-01 | Submit a task in chat with links to the design and materials                | 1         |
| UC-02 | Receive the spec and plan and confirm or correct them                       | 1         |
| UC-03 | Answer the agent's question when it lacks a decision                        | 1         |
| UC-04 | Receive a draft PR with a summary and check results                         | 1         |
| UC-05 | Leave a comment on the PR and get a fix as a new commit                     | 1         |
| UC-06 | Learn the CI result and get the failure fixed                               | 1         |
| UC-07 | Run two tasks (concurrently if the config allows; otherwise queued)         | 1         |
| UC-08 | Ask for task status in chat                                                 | 1         |
| UC-09 | Cancel a task                                                               | 1         |
| UC-10 | Ask a knowledge question with no code involved and get an answer with sources | 1       |
| UC-11 | Restart Jarvis and continue tasks without losses                            | 1         |
| UC-12 | Approve or reject an agent action                                           | 1         |
| UC-13 | Change the `Profile` and see the behavior change in the next task           | 1         |
| UC-14 | See all tasks, their state, and the journal                                 | 1         |
| UC-15 | Watch a live console of the dispatcher or a worker                          | 1         |
| UC-16 | Debug a task: stop a run, retry a stage, send the worker a message          | 1         |
| UC-17 | See usage and limits, and the pause when the budget is exhausted            | 1         |
| UC-18 | Hold the same conversation in a Slack thread                                | 2         |

## Requirements: conversation with the Owner (chat → Slack)

In iteration 1 the channel is the web chat, in iteration 2 Slack. The requirements are the same
for both unless stated otherwise (ADR-0006).

**SLK-01. Message intake.** A new `Owner` message creates a `Thread`. A reply in the thread is
appended to it. In Slack: a DM to the bot or a mention creates a thread; a message in the thread
is a continuation.

**SLK-02. Reply in the thread.** Jarvis replies only in the thread the message came from. Each
task lives in its own thread.

**SLK-03. Sender allowlist (Slack).** Messages from a user not on the allowlist are dropped
without a reply. The check is by user identifier, not by channel. The web app is local and has no
authorization (ADM-07).

**SLK-04. No public address (Slack).** The bot connects to Slack from the laptop via Socket Mode.

**SLK-05. Permissions.** When any run (dispatcher or worker) asks for permission, a card appears
in the task's thread: the tool, a description, the arguments, and `Allow` / `Deny` buttons. With
no response within the time from the config, the request is denied.

**SLK-06. Decision buttons.** Confirming the spec and plan and answering multiple-choice
questions are available as buttons as well as text.

**SLK-07. Progress without noise.** Task progress is updated in a single status message in the
thread. A new message appears only when a human action is needed or there is a result.

## Requirements: Dispatcher

**DSP-01. Task intake.** When a message is a code-change request, the dispatcher creates a
`Task`, the engine creates a `Worktree` and a `jarvis/<task-id>` branch, and a reply arrives in
the thread: what was taken on, the branch, and what will count as done.

**DSP-02. Worker launch.** The engine launches a worker in the task's `Worktree` with the links
from the message, the `Profile`, and the artifacts folder.

**DSP-03. No code.** The dispatcher does not change code or repository files. It only has tools
for managing tasks and replying to the thread (ADR-0004).

**DSP-04. Reply routing.** An `Owner` reply in a task's thread reaches that task's worker: into
the current run if one is in progress, otherwise the reply starts the next run and arrives in its
first message. The engine never leaves a reply waiting for a run nobody is going to ask for — a
task parked in a stage with no watcher would hold it for good, and the owner would get silence.
A reply to a `build` task in `PR Open` leaves it in `PR Open`, still watched: a question or a retro
changes no code. Only when the worker then pushes (`open_pr`) does the task move to `Fixing`, like a
failed CI run or a reviewer's comment would move it; this owner-driven round does not count against the
CI-fix or review round limits.

**DSP-05. Status on request.** On a "status" request, the dispatcher replies with the list of
active tasks: the stage, what it is waiting for, a link to the PR.

**DSP-06. Cancellation.** On a cancel command, the engine stops the run, moves the task to
`Cancelled`, and a message arrives in the thread about what remains: the branch, the PR. Jarvis
does not delete the branch or the PR.

**DSP-07. Knowledge questions.** If a message is a question with no code-change request, the
dispatcher answers with sources from the `Connector` and the repository. It creates no `Task`.

**DSP-08. Worker run limit.** No more than `limits.maxConcurrentWorkers` workers run at once (1
by default). A task in `PR Open` or `Blocked` occupies no slot: there is no process, and when a
CI event, a review event, or an `Owner` reply arrives, the engine launches the worker again,
resuming the session. If the slots are taken, the task or event is queued and a message with its
position arrives in the thread.

**DSP-09. Hangs.** If a run produces no events for more than 10 minutes or waits for a
permission longer than the config allows, a message appears in the thread with what it stopped
on.

## Requirements: Worker and the SDD flow

**WRK-01. Context.** The worker gathers context from the `Design Source`, the `Connector`, and
the repository and writes `context.md`: the sources used with links, the extracted requirements,
the open questions.

**WRK-02. Specification.** The worker writes `spec.md`: what we are implementing, the
boundaries, the acceptance criteria. Every requirement references its source.

**WRK-03. Plan.** The worker writes `plan.md` and `tasks.md`. The `Plan Verifier` checks the
plan for conformance to the spec and the repository rules.

**WRK-04. Confirmation.** The task moves to `Spec Review`, and the spec and plan (briefly, with
a link to the files) go to the thread. Implementation starts only after the `Owner` confirms. A
comment instead of a confirmation sends the worker back to revising the spec or the plan.

**WRK-05. Questions.** If sources contradict each other or a decision that changes the task's
scope is missing, the worker asks one specific question in the thread, and the task moves to
`Blocked` until the answer arrives. The worker does not guess.

**WRK-06. Implementation.** The worker implements the tasks from `tasks.md` in the `Worktree`
and updates their statuses.

**WRK-07. Checks.** The check commands are fixed when the owner approves the spec: the ones in
the repository's `AGENTS.md`, or, when it lists none, the ones the worker found and showed on the
approval card (CON-04). When the worker asks for the PR, the engine itself runs them in the
`Worktree` and refuses on red (ADR-0022). The worker then fixes and asks again, but no more than
`limits.checkRetries` times.

**WRK-08. Review.** The `Reviewer` checks the diff for conformance to the spec, the acceptance
criteria, and the repository rules. Blocking-level findings the worker fixes before opening the
PR.

**WRK-09. PR.** On green checks the engine pushes exactly the commit it checked and opens a draft
PR from the Jarvis account; the worker has no GitHub token (ADR-0022). The description covers:
what was done, the sources, the open questions (written by the worker) and the check results
(written by the engine). Then the worker writes `result.md`.

**WRK-10. Visual verification.** For interface changes, the worker opens the page in a browser
and compares it with the `Design Source`. A screenshot is attached to the PR.

**WRK-11. Limit.** If the checks do not pass after all attempts or the task has exceeded
`limits.taskTimeoutMinutes`, the task moves to `Failed`, and a report arrives in the thread: the
error, the actions taken, the questions.

## Requirements: Context and connectors

**CTX-01. Claude Design.** The worker receives the design via a link or a handoff from Claude
Design and uses it as the source of structure, copy, and appearance.

**CTX-02. Notion.** The worker searches and reads pages within the provided root page.

**CTX-03. Google Docs.** The worker searches and reads documents within the provided folder or
document.

**CTX-04. Search boundaries.** The worker searches only in the sources and boundaries set in the
task or the config.

**CTX-05. Missing access.** If a source is unavailable, the worker reports it in the thread, and
the task moves to `Blocked`. Pretending the source was read is not allowed.

## Requirements: PR and CI

**CI-01. Supervision.** After the PR is opened, the task moves to `PR Open`, and the `Watcher`
starts following that PR's CI and review.

**CI-02. No model while waiting.** While the status has not changed, the `Watcher` does not
launch the model and writes nothing to the thread.

**CI-03. CI result.** When all checks of the current commit have finished, the actual result
arrives in the thread.

**CI-04. CI failure.** If CI is red, the engine fetches the failed log and hands it to the worker
as a file; the worker reads it, determines the cause, and tries
to fix it with a new commit, for no more than `limits.ciFixRounds` rounds. After that the task
moves to `Blocked` with an explanation.

**CI-05. Review comments.** When an allowed reviewer leaves a comment or requests changes, the
worker makes the edits, pushes a new commit, and writes to the thread what was changed. No more
than `limits.reviewRounds` rounds.

**CI-06. Allowed comments only.** The worker reacts only to comments from people on
`allowlist.githubReviewers`. Comments from the Jarvis account and other bots it ignores.

**CI-07. New commit.** After every push the `Watcher` follows the CI of the new commit. Statuses
of old commits it ignores.

**CI-08. Completion.** When CI is green and the review is approved (or the `Owner` wrote
"done"), the task moves to `Done`, and the final summary arrives in the thread. Jarvis does not
merge.

**CI-09. Missed events.** If the laptop was asleep, after waking the `Watcher` compares the
current statuses with the saved ones and processes each change exactly once.

## Requirements: state

**ST-01. Source of truth.** The database holds the threads, messages, tasks with their stage,
branch, PR, and what the task is waiting for, as well as the runs and their events (ADR-0008).

**ST-02. Single writer.** Only the engine changes state. Models change it only through Jarvis
tools (ADR-0004), and write artifacts as files into the task folder.

**ST-03. Journal.** Every stage change, message, CI or review event lands in the `Task Journal`
together with the state change.

**ST-04. Recovery.** After an engine restart, all unfinished tasks continue without `Owner`
involvement. Runs that were interrupted resume from the last completed stage.

**ST-05. Worker recovery.** If a worker process crashed, the engine restarts it, resuming the
session, taking into account the artifacts in the task folder.

**ST-06. Thread memory.** The dispatcher keeps a short summary of the thread: what was asked,
what was decided, the open questions. The full history is not loaded into context every time.

## Requirements: Profile

**PRF-01. SOUL.md.** The agent's role, principles, and style apply in every task.

**PRF-02. USER.md.** The owner's preferences — language, level of detail, format of the plan,
the summary, and the PR — apply in messages and artifacts.

**PRF-03. Profile change.** A `Profile` change takes effect from the next run without restarting
Jarvis.

**PRF-04. Project rules kept separate.** Code and architecture rules come from the repository's
documentation, not from the `Profile`.

## Requirements: Config and limits

**LIM-01. Separate config.** The repository, limits, models per role, allowlist, and connector
boundaries are set in `~/.jarvis/jarvis.config.json`. No secrets there (ADR-0005).

**LIM-02. Config validation.** If the config is invalid, the engine does not start and explains
which field is wrong.

**LIM-03. Run limits.** Every run has limits on the number of steps and the estimated cost from
the config.

**LIM-04. Daily budget.** When the estimated cost for the day reaches `limits.dailyBudgetUsd`,
new runs do not start, a message arrives in the thread, and the web app shows the pause. A run
already in progress finishes its current step. The owner can reset the day's usage from the header
meter (after a confirmation): spent today then counts only runs started after the reset, queued work
starts at once, and a later exhaustion the same day is announced again. Midnight still resets as before.

**LIM-05. Change without restart.** A config change takes effect for new runs.

## Requirements: security and permissions

**SEC-01. Autonomous permissions.** Commands needed for the normal flow (reading, editing in the
`Worktree`, checks, local git on the task branch) are pre-approved; `git push` and `gh` are
denied to the worker, because the engine pushes and opens the PR (ADR-0022). Everything else
goes through a `Permission Request` (SLK-05).

**SEC-02. Write boundaries.** The worker changes files only in its own `Worktree`. Pushes go
only to `jarvis/*` branches. Pushing to the base branch, merging, deleting branches, and
force-pushing are forbidden.

**SEC-03. Untrusted content.** Text from chat, PRs, Notion, Google Docs, designs, and CI logs is
data, not instructions. An instruction inside such text does not change the task's boundaries
and grants no new rights.

**SEC-04. Secrets.** Tokens live in `.env` outside git. They do not end up in logs, console
events, artifacts, or messages. Claude runs receive only the variables they need (ADR-0015).

**SEC-05. No API key.** If `ANTHROPIC_API_KEY` is present in the engine's environment, the
engine does not start and explains why: otherwise runs would be billed via the API.

## Requirements: admin UI

The iteration 1 web app is both the chat and the admin UI. The screen structure, content, and
states are described in `docs/specs/web-ui-design.md`.

**ADM-01. Tasks.** A list of all tasks with the stage, branch, PR, CI state, and what the task
is waiting for.

**ADM-02. Task.** The task page: SDD artifacts, journal, thread, PR, runs.

**ADM-03. Consoles.** A live view of every dispatcher and worker run: model text, tool calls,
results, errors.

**ADM-04. Run history.** Finished runs are stored and open the same way as live ones.

**ADM-05. State and limits.** What is running now, the queue, today's usage, the current limits
from the config.

**ADM-06. Debugging.** Actions: stop a run, retry the current stage, send the worker a message,
cancel the task. Every action lands in the task's journal.

**ADM-07. Local only.** The web app runs on the laptop without authorization and is not
reachable from outside.

**ADM-08. Connections.** Connection status: Claude CLI login (and a warning about
`ANTHROPIC_API_KEY`), the GitHub token, connectors, Slack (iteration 2).

## Edge cases

| Case                                                             | Expected behavior                                                                | Requirement  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------ |
| A new task when all worker slots are taken                       | Queued, message with the position                                                 | DSP-08       |
| An `Owner` reply outside the task's thread                       | A new thread; the dispatcher asks whether it is about an existing task           | DSP-04       |
| The `Owner` stays silent after a question                        | Task in `Blocked`, reminders no more than once a day                             | WRK-05       |
| The laptop fell asleep mid-run                                   | After waking, the interrupted run resumes; CI events are processed exactly once  | CI-09, ST-05 |
| The engine crashed or was restarted                              | Recovery from the database                                                        | ST-04        |
| The daily budget is exhausted                                    | New runs paused, a message, a banner in the web app                               | LIM-04       |
| The subscription limit is exhausted (the CLI returns a limit error) | Tasks paused, a message with the recovery time if the CLI reports it           | LIM-04       |
| Flaky CI: red with no relation to the changes                    | The worker marks it as possibly flaky, reruns once, then reports                  | CI-04        |
| A reviewer writes a comment not addressed to the agent           | No edits; only a mention in the summary                                           | CI-05        |
| A PR comment from a bot or the Jarvis account                    | Ignored                                                                           | CI-06        |
| Two tasks change the same file                                   | Each in its own `Worktree`; a human resolves the conflict in the PR               | DSP-02       |
| A design link without access                                     | A message, task in `Blocked`                                                      | CTX-05       |
| A permission request with no response                            | Denied on timeout, recorded in the journal                                        | SLK-05       |
| An "ignore the rules" instruction in a PR comment or a document  | Not followed                                                                      | SEC-03       |
| Cancellation during a push                                       | The push completes, the task is `Cancelled`, the PR remains                       | DSP-06       |
| `ANTHROPIC_API_KEY` is present in the environment                | The engine does not start and explains why                                        | SEC-05       |

## Non-functional requirements

- **NFR-01. Startup.** Postgres comes up with a single compose command from the README (the
  password comes from secrets, ADR-0015); the engine and the web app with a single command from
  the README.
- **NFR-02. Responsiveness.** The first reply in the thread to a new task arrives within 30
  seconds.
- **NFR-03. Limit economy.** No model call happens just to check a status. The Watcher polls
  GitHub no more often than once per `watch.pollSeconds` (60 s by default).
- **NFR-04. Resilience.** Restarting the engine or a worker loses no tasks and duplicates no
  messages.
- **NFR-05. Observability.** For every task, what happened can be reconstructed from the
  journal, the run events, and the artifacts.
- **NFR-06. Reproducibility.** A webinar participant can reproduce the PoC on their own accounts
  from the README in no more than an hour, not counting the creation of the bot's GitHub
  account.
- **NFR-07. Task duration.** The demo task (one page) goes from the message to the draft PR in
  20–40 minutes.
- **NFR-08. Live web app.** New run events appear in the console in under a second.

## Out of scope

- Supervising long jobs (backfills, migrations, pipelines, releases) — a next step.
- A second engine (Codex) as a worker or reviewer — a next step.
- Multiple owners, authorization, team use.
- Self-directed behavior changes beyond what is allowed: the agent writes memory only under
  `## Learned` in `USER.md` (the dispatcher and the worker, by the rules of ADR-0021) and changes
  the allowed config fields only at the owner's explicit request (ADR-0013). It never edits
  `SOUL.md`, its own prompts or a repository's `AGENTS.md` on its own.
- Merge, deploy, branch deletion.
- Ticket systems (Jira, Linear) as input.
- CI triage for other people's PRs and `main`.
- Attaching to a live terminal (TTY) session: the console shows structured run events.

## Open questions

### Closed by the owner's decisions (2026-10-26)

- [x] Channel for the first iteration → the web app (chat + admin UI); Slack with threads in
      iteration 2.
- [x] Whose name on the PR → a separate Jarvis account with its own token (CON-09).
- [x] Plan → Max 5x; the goal is to show it works without burning the whole limit (CON-06).
- [x] Where the admin UI lives → in this repository, iteration 1.
- [x] Limits → a separate config (LIM-01).
- [x] Secrets → `.env` for now (CON-10).
- [x] Design → the owner makes it themselves from the `web-ui-design.md` brief.
- [x] Connectors → own MCP servers with tokens (CON-11).
- [x] Where the agent's data lives → the definition in `agent/` (git), personal and working data
      in `~/.jarvis`, state in Postgres (ADR-0009, ADR-0008).

### For the owner

- [ ] Which demo task and which repository: a separate teaching app (which one?) or an existing
      project?
- [ ] Who is the reviewer in the demo: the owner or a second account? This determines who goes
      on `allowlist.githubReviewers`.
- [x] Accept or amend the initial ADRs → all accepted; the current set is
      [`docs/decisions/architecture/`](../decisions/architecture/README.md).

### For the architecture

- [ ] Exactly which MCP servers we take for Notion and Google Docs and what token permissions
      they need (ADR-0015).
- [ ] The format for handing the design from Claude Design to the worker.
- [ ] How the worker's `Subagent`s appear in the console: separate streams or nested events.

### To verify before the start

- [ ] A full run of the demo task: how much estimated cost and what share of the Max 5x limit it
      consumes.
- [ ] Fine-grained PAT permissions for reading check runs (a classic PAT or another approach may
      be needed).
- [ ] Socket Mode on free Slack (iteration 2).
