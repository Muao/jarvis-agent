# Webinar concept for sales and marketing

## Your own AI development agent: from a task to a verified pull request

**Status:** concept for webinar preparation, version 2. The prototype's scope and architecture have been
refined. The prototype, sources and materials must be prepared and verified before the announcement.
Updated 2026-11-09: sections 6, 8–10, 16 and 19 describe the architecture as implemented (engine +
Postgres + `claude -p` runs), replacing the earlier tmux / `state.json` / channels plan.

**Format:** a hands-on webinar with a demonstration, a walkthrough of technical decisions and a short exercise.

**Implementation level:** proof of concept (PoC), an educational prototype.

**Recommended duration:** 90 minutes including the course pitch and Q&A.

**Basis:** [Jarvis Agent, concept v0.2](https://claude.ai/artifact/8BzqCfgQC2LsZ8Xw4SLHLn). Version 2 adds:
a design from Claude Design as task input, the "dispatcher + workers" architecture on a Claude Code
subscription, a custom Slack channel, CI follow-up, an agent admin panel, the split between what is
prepared in advance and what is done live, and a walkthrough of the technical challenges.

## 1. The concrete agent idea

Jarvis receives a task in Slack: a link to a design in Claude Design and to materials in Notion and
Google Docs. It finds the needed information on its own, writes up a specification, builds a plan,
implements the feature in a separate branch, runs the checks, does a review, opens a pull request and then
keeps watching it: waits for CI results, fixes reviewer remarks and sends a summary to Slack.

Everything runs on the developer's laptop through their Claude Code subscription. There is no separate
payment for the API.

The agent's profile describes its role, working principles, the owner's preferences and the format of the
results. The agent applies these settings in every task.

**The core promise:** show how to build a personal agent that takes a design and project materials,
executes a task following Spec-Driven Development (SDD) — a specification-based development process — and
carries it through to a verified PR.

A participant gets an educational PoC and can explore its components and repeat the demonstration.

**What Jarvis does in the prototype:**

1. The main flow: design and task → context → spec and plan → code → checks → review → PR → fixes from
   comments → a message in Slack.
2. CI follow-up: watches its PR's checks, triages failures, tries to fix them or reports with an explanation.
3. Parallel work: runs up to two tasks at once, each in its own branch.
4. Knowledge search: finds an answer in Notion and Google Docs and gives links to the sources.

**The user's action:** post a task in Slack, switch to other work and receive a message when there is a
result, a status change or a decision to make.

## 2. Title and subtitle

**Main title:** Your own AI development agent: from a task to a verified pull request

**Subtitle:** We assemble a proof of concept of a personal agent on a Claude Code subscription: it takes a
design from Claude Design, finds context in Notion and Google Docs, executes the task against a
specification, watches CI and review, and messages you in Slack.

**Short version for ads:** Your own AI agent that carries a task to a pull request on its own

We explain the technical concepts through the demonstration: what the agent found, which decisions it
made, whom it delegated work to, and what result it prepared.

## 3. Who it is for

Primary audience: Middle and Senior developers who use AI and want to build their own task-execution
process with access to project materials.

- For those who work with AI step by step: how to delegate context gathering, specification writing and
  the subsequent execution.
- For those who have already built a first agent: how to add external sources, an owner profile,
  spec-driven work, specialized roles and CI follow-up.
- For those growing in Agentic Engineering: a complete example that can be launched and dissected,
  together with the technical decisions and their trade-offs.

A basic understanding of code, Git and pull requests is required. To repeat the PoC you need a Claude Code
subscription (Pro or Max), a GitHub repository and a free Slack workspace. The exact requirements go in
the README.

## 4. Audience pain points

- The design lives in Claude Design, the requirements in Notion, additional decisions in Google Docs, the
  implementation rules in the repository. All of this has to be gathered by hand.
- AI knows only what the developer managed to pass into the current request.
- After every clarification you have to explain again what to do and what result is expected.
- Personal preferences about planning, questions and answer format get lost between chats.
- There are already separate agents, but it is unclear how to combine them into the execution of one task.
- During a long task it is hard to see which context was used, what is already done and what remains.
- After the PR is created you have to come back and check whether CI has finished, whether a review has
  arrived and whether fixes are needed.
- An API-based agent costs money per run, and with a subscription it is unclear how to make it autonomous.

The personal value of the webinar: learn to combine knowledge sources, tools and agents into your own
development process and get a working foundation for experiments.

## 5. The scenario we show

### Example task for the demonstration

> Додай у навчальний застосунок сторінку програми курсу. Дизайн сторінки за цим посиланням у Claude
> Design. Структуру та описи занять знайди в Notion. Правила подачі й вимоги до інтерфейсу знайди в
> Google Docs. Використай компоненти й конвенції репозиторію. Покажи специфікацію та план, реалізуй
> сторінку і підготуй PR. Стеж за CI та рев'ю, пиши мені в Slack.
>
> (English: Add a course curriculum page to the training app. The page design is at this link in Claude
> Design. Find the structure and lesson descriptions in Notion. Find the presentation rules and interface
> requirements in Google Docs. Use the repository's components and conventions. Show the specification and
> the plan, implement the page and prepare a PR. Watch CI and review, message me in Slack.)

The task is written in Slack. The final requirements are fixed after the design, the materials and the
app's initial state are prepared.

### What the human provides as input

- A description of the desired result in Slack.
- A link to the design in Claude Design.
- A link to the course's root page in Notion and to the folder with Google documents.
- The repository the agent works with (one for the demo).
- The agent and owner profile, prepared once.

### What the agent does on its own

1. The dispatcher accepts the task in Slack, records it in the state and creates a separate worktree (a
   separate working copy of the repository) and a branch.
2. It launches a worker, a separate Claude Code session for this task.
3. The worker fetches the design, reads Notion and Google Docs through connectors, and analyzes the repository.
4. It writes `context.md` with sources and open questions, then `spec.md` with acceptance criteria.
5. It prepares `plan.md` and `tasks.md`. The dispatcher sends the spec and plan to Slack for approval.
6. After approval it implements the feature and updates the task statuses.
7. It runs tests, lint and typecheck. If a check is red, it fixes it, with at most three attempts.
8. A separate reviewer agent checks the changes against the spec and the repository rules.
9. It opens a draft PR and writes `result.md`.
10. The Watcher (a timer with no model) watches the PR's CI and review, and the engine resumes the worker
    when the status changes.
11. If CI fails, the worker reads the log and tries to fix it. If a reviewer leaves a comment, the worker
    makes the changes and pushes a new commit.
12. The dispatcher sends a summary to Slack: what was done, which checks passed, links to the PR and the
    sources. The merge is done by a human.

If the materials contradict each other or an important decision is missing, the agent asks one specific
question in Slack and waits for the answer.

### What the human gets

- Gathered context with links to the sources.
- A specification, a plan and a task list with statuses.
- The implemented change in a separate branch.
- Check results and reviewer remarks.
- A draft PR with an explanation of what was done and the open questions.
- Slack messages about CI, review and the next steps.
- The task's state, session logs and agent consoles visible in the admin panel.

## 6. How the prototype is built

### The architecture in plain words

Jarvis consists of one long-lived engine and short-lived Claude runs: a dispatcher and workers.

**The engine** is an ordinary Node service with no model inside. It holds all state in Postgres, starts
Claude, watches GitHub and serves the web app. A model can change state only by calling the engine's
tools (an MCP server), so after a restart the engine reads the database and continues from the same place.

**The dispatcher** is the Claude role the human talks to. It is not a permanent session: every owner
message starts a short `claude -p` run that resumes the thread's session. The dispatcher does not write
code: it accepts tasks, answers questions and reports results.

**A worker** is a `claude -p` run for one task in its own worktree. Two tasks mean two workers that do not
interfere with each other. The worker goes through the SDD process and engages specialized subagents.
While a task waits — for approval, CI or a review — there is no process at all; the engine starts the
worker again later, resuming its session.

**The Watcher** is a timer in the engine that checks CI and review through GitHub. As long as nothing has
changed, the model is not launched and the subscription limits are not spent.

**The Slack channel** is an adapter in the engine. It connects to Slack over Socket Mode (no public
address), turns a message into a thread and posts replies, cards and buttons back. The web chat is the
same port with a different adapter.

**The admin panel** is a web app based on Agent Ops Center. It shows tasks, state, session logs and agent
consoles, so you can see what is happening and debug.

```
Slack / web chat ⇄ Engine (Node: state machine, limits, scheduler) ⇄ Postgres
                     ├─→ claude -p  dispatcher run (per owner message, resumes the thread session)
                     ├─→ claude -p  worker run 1 (worktree A) → subagents
                     ├─→ claude -p  worker run 2 (worktree B) → subagents
                     ├─← Jarvis MCP server (tools: the only way a model changes state)
                     └─← Watcher (timer: PR CI and review via GitHub, no model)
Admin panel (Agent Ops Center) ← tasks, journal, run events (live consoles)
```

### Components

| Component | Role | What we show |
| --- | --- | --- |
| Claude Code subscription | The engine for all roles | The official `claude` CLI under the owner's account, no API key |
| Engine | The long-lived service that holds state and starts Claude | The state machine, limits, the tools a model may call |
| Dispatcher | The role that talks to the owner and manages tasks | Task intake, questions and notifications |
| Workers | Execution of one task | Separate `claude -p` runs, separate worktrees, up to two in parallel |
| Specialized agents | Roles inside the worker | Context researcher, plan verification, implementer, reviewer |
| SOUL.md | The agent's role, principles and working style | When the agent clarifies a task, how it reports progress |
| USER.md | The owner's preferences | Language, level of detail, format of the plan, summary and PR |
| Repository rules | Project conventions | Architecture, components, check commands |
| Claude Design | The design source | The page mock-up the agent takes the structure and look from |
| Notion and Google Docs connectors | Searching and reading context | Course structure, presentation rules, interface requirements |
| State | Resuming after a restart | Postgres: threads, tasks, stages, branches, PRs, what we are waiting for, runs and their events |
| SDD documents | A visible execution process | context, spec, plan, tasks, result in the task folder |
| Checks | Feedback | Tests, lint, typecheck; for the UI, a browser inspection |
| Watcher | Waiting for CI and review | Polling GitHub without a model, waking the dispatcher on a change |
| Slack channel | The interface for tasks and messages | Tasks, questions, progress, permission confirmations |
| Admin panel | Visibility and debugging | Tasks, state, logs, agent consoles |

All roles run on one engine and one subscription. The role split does not require several paid models.

### Where the state lives

```
Postgres                 threads, messages, tasks (stage, branch, PR, what we wait for), journal,
                         runs and their events, permission requests, watches, usage
~/.jarvis/tasks/<id>/    context.md, spec.md, plan.md, tasks.md, result.md
~/.jarvis/USER.md        the owner's preferences and what Jarvis has learned
```

Only the engine writes state. A model changes it through Jarvis tools and writes its documents into the
task's own folder. This way two parallel tasks never overwrite anything shared.

### Personalization with concrete examples

In SOUL.md we write: "prepare a specification before implementing", "ask a question if the answer changes
the task's scope", "show the current stage".

In USER.md we write: "summaries in Ukrainian", "the plan as a short list", "at the end give links to the
sources, the list of changes and the check results".

Architectural constraints and code rules stay in the project documentation. The owner profile defines only
the owner's preferences.

## 7. How we show Spec-Driven Development

The process leaves artifacts the participants can open:

- `context.md`: where the information came from, which documents and design were used, what is missing.
- `spec.md`: what we implement, the task boundaries and the acceptance criteria.
- `plan.md`: how we implement it, which components we change and how we verify.
- `tasks.md`: subtasks with execution statuses.
- `result.md`: what was done, which checks passed and what remains.

The participant sees how the design and the found sources turn into requirements, the requirements into a
plan, and the plan into code changes.

## 8. What is prepared in advance and what we do live

We do not assemble the full infrastructure live: that would eat the whole session and make the demo
fragile. We prepare a working prototype in advance, and during the live session we run it on a real task
and build out a few parts where the principle shows well.

### Prepared before the session

- A training repository with CI, tests and the app's initial state.
- The page design in Claude Design.
- Materials in Notion and Google Docs, available for participants to copy.
- A Slack workspace, a Slack app and the engine's Slack adapter.
- The dispatcher: instructions, worker launching, state handling.
- The worker and the specialized agents: context researcher, plan verification, implementer, reviewer.
- SDD document templates.
- The Watcher for CI and PR review.
- Permission settings for autonomous operation.
- The admin panel: tasks, state, logs and consoles.
- A backup recording of a full run.

### Done live

- We fill in SOUL.md and USER.md and show how one rule changes the agent's behavior.
- We start Jarvis and post a task in Slack.
- We answer the agent's questions and approve the spec and the plan in Slack.
- We post a second task in parallel and show two workers.
- We add or change one specialized role, for example a rule for the reviewer.
- We leave a comment in the PR and watch the agent handle it.
- We break one test in CI and show the failure triage.
- We open the admin panel and walk through what is happening inside: state, logs, consoles.

Implementing the feature takes 20–40 minutes. We post the task at the start of the session, and while the
agent works we walk through the architecture and the technical challenges. If the agent runs late or
breaks, we switch to the recording and say so openly.

## 9. Live demonstration script

1. We show the app before the changes, the design in Claude Design and the materials in Notion and Google Docs.
2. We open SOUL.md and USER.md and add one rule live.
3. We start Jarvis and post a task in Slack.
4. The agent replies in Slack: it took the task, created a branch, and shows what it is searching for.
5. While it gathers context, we explain the architecture: dispatcher, workers, state, subscription.
6. The agent sends the spec and the plan. We open `context.md` and `spec.md`, check the origin of the
   requirements, and approve in Slack.
7. We post a second task and show two workers in the admin panel: two live consoles side by side.
8. While the workers run, we walk through the technical challenges (section 10).
9. We look at the code changes, the check results and the review. We show a retry if one happened.
10. We open the finished page, compare it with the design and the spec, and show the draft PR.
11. We show that CI is still running while Jarvis has saved its state and is waiting.
12. We receive a Slack message about the CI result.
13. We leave a comment in the PR, the agent makes the fix, CI for the new commit starts.
14. We break a test, show the failure triage and the Slack message.
15. The final message: the conditions are met, the PR is ready for human review.

The demo's central moment: the agent found the materials itself, applied the owner profile, executed the
task through a visible SDD process and continued the follow-up after the PR was created — while we could
see what was happening inside the whole time.

## 10. Technical challenges we walk through

These questions come up for everyone who builds a similar agent. We walk through them while the agent
works and show the solutions in the PoC code.

| Challenge | Why it arises | How we solve it in the PoC |
| --- | --- | --- |
| Subscription instead of API | The Agent SDK and third-party apps work through an API key; plugging a subscription token into third-party code is forbidden by the terms | Orchestration calls only the official `claude` CLI under the owner's account. One agent per one person's subscription |
| Subscription limits | A 5-hour window and a weekly limit apply; several subagents burn them fast | The Watcher runs without a model; the model is launched only for meaningful work; attempt limits per stage |
| Dispatcher context overflow | A long session accumulates history; details get lost after compaction | The dispatcher keeps nothing "in its head": state lives in Postgres, each thread has a short summary, and every owner message is a fresh short run |
| Slack channel | The agent must be reachable from Slack without a public address; Claude Code channels are in research preview and work only in an interactive session | The engine itself connects to Slack over Socket Mode and starts a `claude -p` run per message. No channels mechanism and no experimental flags |
| Free Slack limitations | At most 10 apps, 90 days of history | The bot takes one slot; history is not needed because the state is stored locally |
| Dispatcher-to-worker communication | The worker is a separate process with its own session | Neither talks to the other directly. The dispatcher calls an engine tool (`create_task`, `send_to_task`); the engine starts the worker run or writes into its input. The worker reports back through tools as well |
| Parallel tasks | Two tasks in one working copy conflict over files, ports and dependencies | A separate git worktree and branch per task; separate ports for the dev server and tests |
| Permissions without a human | Every permission request stops the session until a human answers | Allowed commands are set in the settings; the rest of the requests are forwarded to Slack with `yes <id>` / `no <id>` confirmation. Merge and dangerous actions stay with the human |
| CI follow-up from a laptop | A GitHub webhook cannot reach a laptop without a public address | The Watcher polls GitHub on a schedule, and the engine resumes the worker when something changed. After the laptop sleeps, it catches up on missed statuses |
| The laptop goes to sleep | The dispatcher and the watcher stop with it | `caffeinate` for long tasks; after waking, the watcher compares against the saved state |
| PR comments | The agent could react to strangers' comments or to its own and loop | We process only comments from allowed people addressed to the agent; a limit on fix rounds |
| Prompt injection | Text from Slack, PRs, Notion or CI logs lands in the model's context | A sender allowlist in the Slack channel; external content is treated as data, not instructions; minimal write permissions |
| Connectors in workers | Notion and Google Docs must be available in the sessions the dispatcher launches | We connect them via MCP and verify access in a worker before the session |
| The design from Claude Design | The worker needs the design in a format it can read | We pass the design through the handoff into Claude Code. The format is verified during preparation |
| Visibility and debugging | With several sessions running, it is unclear what is happening where | The admin panel: state, event journal, and a live console per run — every event a run emits is stored and streamed to the browser |
| Demo stability | The agent runs for 20–40 minutes and may make a mistake | The task starts at the beginning of the session; there is a backup recording; errors are shown as part of the walkthrough |

## 11. What a participant gets

### Materials we prepare

- A starter repository with the agent PoC and launch instructions.
- The code of the engine, the agent definition (dispatcher, worker, subagents), the Slack adapter and the watcher.
- SOUL.md and USER.md templates.
- Definitions of the specialized agent roles.
- Templates for context, specification, plan, tasks and result.
- An example connector configuration without the speaker's personal credentials.
- Example documents and a design for repeating the scenario with your own accounts.
- The demo task and an example result.
- The admin panel for viewing state, logs and consoles.
- Instructions for setting up the Slack app on the free plan.
- An adaptation checklist: sources, profile, project rules, agent roles, checks.

### What you can do after the webinar

A participant will be able to reproduce the example on their own subscription, change the profile and the
answer format, connect their own materials, post a similar bounded task and set up CI follow-up with a
Slack notification.

This is an educational proof of concept. The main value of the materials: the agent's structure is visible
and open to change.

### Short exercise

The participant picks their own task and fills in three parts of a template:

1. What result is needed.
2. Where the agent should look for the design, the requirements and the rules.
3. By which signs to verify completion.

Additionally, they write down one requirement of their own for the agent's behavior and one for the result
format.

## 12. Webinar program

| Time | Block | Practical content |
| --- | --- | --- |
| 0–10 min | The task and the agent start | The app, the design, the materials; a rule in USER.md; a task in Slack |
| 10–20 min | How Jarvis is built | Dispatcher, workers, state, subscription, Slack channel |
| 20–30 min | Context and specification | The found sources, the spec and plan in Slack, approval |
| 30–50 min | Execution and technical challenges | A second task in parallel, a new role live, challenge walkthrough while the agents work |
| 50–60 min | PR, review and CI | Draft PR, a PR comment, a CI failure and its triage, notifications |
| 60–65 min | Admin panel | State, logs, agent consoles, how to debug |
| 65–70 min | Short exercise | The participant's task, their sources, preferences and notification condition |
| 70–80 min | Transition to the course | Where we go deeper into the components shown |
| 80–90 min | Q&A | Questions about the PoC, running it, and the course program |

Connectors, Slack and the environment are set up before the session. Live, we show the configuration and
the actual operation.

## 13. Link to the course

| What the participant sees at the webinar | Which course materials we connect it to |
| --- | --- |
| Searching and reading through connectors, a custom Slack channel | MCP and agents' access to tools and context |
| Gathering context from several sources | Organizing documentation, architecture decisions and project knowledge |
| Specification, plan and tasks | The Spec-Driven Development workflow |
| Plan verification | Plan Verifier |
| The dispatcher, workers and specialized roles | Agent roles, instructions and orchestration |
| Verifying changes | Your own AI reviewer and the DevDigest training project |
| Behavior on a concrete example | Evaluating agent quality (evals) |
| CI follow-up | CI integration |
| The admin panel, logs, hooks | Agent observability |

We use SOUL and USER as an easy-to-grasp way to personalize the demo agent. We do not call them separate
course lessons without checking against the program.

### Transition to the sale

We come back to the completed task and show what the result was made of: the design, the connected
sources, the context, the specification, the plan, the agent roles, the review, the checks and the CI
follow-up.

The course covers the practices needed to build and adapt such processes. We show the specific matching
lessons and artifacts.

Career motivation remains an additional argument: the participant gets a practical project and can explain
its architecture and the decisions made.

## 14. Ready-made announcement copy

**Your own AI development agent: from a task to a verified pull request**

The design is in Claude Design, the requirements in Notion, the decisions in Google Docs, the code and the
rules in the repository. To delegate a task to AI you have to gather this context by hand, and then also
watch CI and review.

At this hands-on webinar we will show how to assemble a proof of concept of a personal agent on a Claude
Code subscription. It accepts a task in Slack, finds the needed materials on its own and carries the task
through to a verified PR.

We will set up the agent's role and your preferences, connect the sources and walk through the Spec-Driven
Development workflow: from gathered context and a specification to a plan, implementation, checks and a
draft PR. While the agent works, we will go through the technical decisions: how to do without the API,
how to run two tasks in parallel, how the agent waits for CI without burning the limits.

**At the webinar you will see:**

- How the agent takes a design from Claude Design and finds context in Notion, Google Docs and the repository.
- How to describe its role, working principles and the desired result format.
- How to turn the found requirements into a specification, a plan and subtasks.
- How the dispatcher and the specialized agents run several tasks in parallel.
- How the agent watches CI and review, fixes remarks and messages you in Slack.
- How to see what is happening inside the agent and debug it.

**After the webinar you will get** a starter PoC, profile and SDD document templates, and instructions for
repeating the demonstration with your own subscription and credentials.

It suits developers starting to work with agents, and those who have already built a first automation and
want to combine context, personalization and task execution into their own workflow.

## 15. Explanations for the sales team

**What kind of agent is this?**

A personal agent for coding tasks. You write it a task in Slack with links to the design and the
materials. It gathers context, writes up a specification and a plan, engages the needed roles and prepares
the changes for a PR. Then it watches CI and review, fixes remarks and notifies the owner.

**Do you have to pay for the API?**

No. The agent works through a Claude Code subscription (Pro or Max) on the owner's computer. The
constraints: the subscription limits and the "one subscription — one person" rule.

**What is the benefit if the person already has an agent?**

They can see how to combine external sources, personal preferences, SDD, parallel tasks and CI follow-up,
and which technical problems come up along the way. A participant can explore the PoC code and take the
parts they need into their own experiments.

**What does long-running task mean?**

A task may wait for an external event: CI finishing, a review or a user's answer. Jarvis stores its state
on disk, a separate script checks for events, and the model is launched only when there is something to do.

**What does personalization mean?**

The profile defines the agent's role and working style, and the owner's settings describe the language,
the level of detail, the format of the plan and of the final result. The project rules are kept separately.

**Is a paid Slack needed?**

No. The bot runs on a free workspace and takes one of the ten allowed apps.

**Are corporate documents needed?**

For repeating it we prepare demo materials and a design that can be copied into your own accounts. For
their own tasks a participant uses the sources they have access to.

**Will this be a ready-made system for a company?**

No, it is an educational PoC for one person. Team usage, a second engine and long-job follow-up are
described as next steps.

## 16. What we prepare before the session

- A training repository with CI and a clear task.
- The page design in Claude Design and a verified design handoff to the worker.
- Materials in Notion and Google Docs; search and reading through both connectors from a worker session.
- A Slack workspace, the app, the engine's Slack adapter, the sender allowlist.
- The dispatcher, the worker, the specialized roles, the SDD templates.
- State persistence and a dispatcher restart without losing tasks.
- Two parallel tasks in separate worktrees.
- Permission settings and forwarding permission requests to Slack.
- The Watcher for CI and review, and Slack notifications.
- Handling a PR comment and a test failure in CI.
- The admin panel with state, logs and consoles.
- The starter repository and the instructions for repeating it.
- A backup recording of a full run.

Before the announcement we run the full scenario on the prepared sources at least twice.

## 17. How we verify we deliver on the promise

- The task was posted and followed up in Slack.
- The agent actually received the design from Claude Design and information from Notion and Google Docs.
- The origin of the requirements can be traced in the specification.
- The owner's settings are visibly applied in the behavior and the summary.
- The participation of specialized roles and two parallel tasks were shown.
- The specification, the plan, the tasks and their state are visible.
- The code, the check results and the draft PR were produced.
- Waiting for CI, failure handling, a PR comment and a new commit were shown.
- The state, logs and consoles are visible in the admin panel.
- Everything ran on the subscription, with no API key.
- The participant receives the materials and the instructions to repeat the PoC.

## 18. Long-running tasks and notifications

### PR and CI follow-up

Example command in Slack:

> Стеж за цим PR. Повідом, коли всі перевірки для актуального коміту завершаться, коли рев'юер попросить
> зміни або коли буде отримано схвалення.
>
> (English: Watch this PR. Notify me when all checks for the current commit finish, when a reviewer
> requests changes, or when an approval arrives.)

Jarvis stores the follow-up conditions and the link to the PR. CI and review statuses are tracked
separately: passing tests do not mean human approval.

Example sequence:

1. The PR is open, CI is running, the review is not finished yet.
2. CI finishes. Jarvis reports the actual result.
3. If CI is red, the worker reads the log, tries to fix it and pushes a new commit.
4. A reviewer leaves remarks. Jarvis shows them and makes the fixes.
5. After the push, the new commit's checks are tracked.
6. The required review state is reached. Jarvis reports that the conditions are met. The merge decision is
   made by a human.

Example messages:

- "PR created. CI is running, waiting for results."
- "The current commit's checks have passed. Human review is still pending."
- "CI failed on `course-page.spec.ts`. Cause: a selector changed. Fixing it."
- "The reviewer left two remarks. Preparing fixes."
- "Fixes added. CI for the new commit is running."
- "Checks passed, approval received. You can move on to your final review."
- "After three attempts the task was stopped. Here is the error, the actions taken and the questions."

### How waiting works

- The Watcher checks statuses through the GitHub API on a schedule.
- The state is stored in the database, separately from the conversation with the model.
- No change produces no message and no model launch.
- The model is engaged when an error needs investigating, remarks need handling or a summary needs preparing.
- The last processed event, the notification conditions and the attempt limits are stored.
- Completion, a question to a human and limit exhaustion are distinct states.
- Follow-up works while the laptop is awake. After waking, the watcher catches up on missed statuses.

### Long-job follow-up

The original Jarvis envisions follow-up for backfills, migrations, nightly pipelines and releases. The PoC
does not include this: we describe it as a next step, because the mechanism is the same as for CI — only
the status source changes.

## 19. The full Jarvis capability map

The target concept. The "PoC" column shows what goes into the webinar prototype.

| Part of Jarvis | What it contains | PoC |
| --- | --- | --- |
| Inputs | Slack, a ticket, a CI event, an alert, a watch command, a schedule | Slack and a CI event |
| Task → PR | Clarification, context, plan, worktree, checks, retries, AI review, draft PR | Yes |
| Design as input | A mock-up from Claude Design | Yes |
| PR follow-through | Comments, rework, repeated CI control | Yes |
| Context search | Search in Notion, Google Docs, Slack, tickets; answers with sources | Notion and Google Docs |
| Found knowledge → action | Turning an answer into documentation or a coding task | No |
| CI triage | Log and diff analysis, flaky vs regression, the next action | For its own PRs |
| Long-running watch | Jobs, migrations, backfills, pipelines, releases | No, a next step |
| Parallelism | Several tasks at once | Up to two tasks |
| Personal home | SOUL.md, USER.md, memory, task journals | SOUL, USER, journals |
| Execution state | Tasks, sessions, attempts, statuses, questions, events | Postgres and task files |
| Admin panel | Tasks, state, logs, consoles, debugging | Yes, based on Agent Ops Center |
| Engines | Claude Code; Codex as a second worker or reviewer | Claude Code only |
| Personal changes | Memory and proposing new rules with confirmation | No |
| Execution control | Limits on attempts, time and calls; handover to a human | Attempt limits |
| Access | Separate read and write permissions, an action journal | Allowlist in Slack, Claude Code permissions |
| Team growth | Shared channels, several people, audit | No |

### Development sequence

1. The Slack channel, the dispatcher and the worker; a task to a PR with checks and state persistence.
2. Connectors, Claude Design and CI follow-up.
3. Parallel tasks and the admin panel.
4. Long-job follow-up.
5. A second engine, personal memory and behavior-change proposals.
6. Team usage.

In the webinar PoC we show steps 1–3. The rest stays on the development map.

### What we verify before implementation

- The `claude -p` stream-json output on the CLI version we pin: the format changes between versions.
- Socket Mode on the free Slack plan.
- Access to the Notion and Google Docs connectors from sessions the dispatcher launches.
- The format of the design handoff from Claude Design to Claude Code.
- The current subscription limits on a full run of two tasks.

The example Slack messages and other companies' metrics from the original concept are illustrations. We do
not present them as results of our PoC.
