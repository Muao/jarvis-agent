---
status: draft
date: 2026-10-26
owner: Ivan Lapa
plan: TBD — after UI design
---

# Spec: Web UI design brief — Jarvis chat and admin panel

Spec ID: `SPEC-web-ui-design` · Source of product requirements: [`abstract-project-spec.md`](abstract-project-spec.md)
(IDs `SLK-*`, `DSP-*`, `WRK-*`, `CTX-*`, `CI-*`, `ST-*`, `PRF-*`, `SEC-*`, `ADM-*`, `NFR-*`).

This is a brief for the design that the owner draws in Claude Design. The document fixes the structure
of the screens, their content, data, actions and states. Colors, fonts, spacing and the visual language
are deliberately left undefined: those are the owner's decisions. Once the design is ready, we will write
the web-layer specification with EARS criteria based on it.

## Goal and scope

In the first iteration the web app plays two roles:

- **Chat with Jarvis.** This is where the owner submits tasks, answers questions, approves the spec and
  plan, and allows or denies agent actions. In iteration 1 the `SLK-*` requirements of the abstract spec
  are implemented by this chat.
- **Admin panel.** Shows all tasks, state, Claude sessions, event journals, limits and connections.
  Supports debugging: stop a run, retry a stage, write into a session.

Slack with threads arrives in iteration 2 and must map onto the same 1:1 model. Every top-level owner
message opens a `Thread`. All further conversation about it (agent replies, questions, approvals,
progress) happens inside that thread. That is why we build the web chat as a list of threads, not as
one endless feed.

**What we design in iteration 1:** the shell, Chat, Tasks, Task detail, Session console, Overview, Config & limits,
Connections, plus shared components and states.

**What we leave for iteration 2:** Slack (only an inactive row on Connections), weekly limit-usage
history, editing the config from the UI, the mobile version.

### The model the UI shows

| Entity | What it is for the UI |
| --- | --- |
| `Thread` | A conversation between the owner and Jarvis. Starts with a top-level message. May spawn 0 or 1 `Task` |
| `Message` | A message in a thread: from `Owner`, from `Jarvis`, or a service card (status, decision, question, permission) |
| `Task` | Work on code from intake to the end of PR follow-up. Has a `Task Stage` (see the glossary of the abstract spec) |
| `Session` | A Claude CLI session (`claude -p --resume`). A thread has a dispatcher session; a task has one or more worker sessions |
| `Run` | One CLI invocation within a session: from process start to end of turn. Has tokens, `total_cost_usd`, duration, status |
| `Run Event` | A stream-json event: agent text, a tool call (input and result), an error, a system event |
| `Artifact` | A task file: `context.md`, `spec.md`, `plan.md`, `tasks.md`, `result.md` |
| `Permission Request` | A permission request from the CLI via `--permission-prompt-tool`: tool, description, input data |
| `Limits` | Values from the config file. Read-only in the UI |
| `Usage` | Notional cost (`total_cost_usd` from the CLI) for today compared to the daily limit |

Cost in the CLI on a subscription is notional: the owner pays no real money for it. The UI always labels
it as `notional $` to avoid confusing it with an API bill.

## Navigation and shell

Left-hand navigation with five items plus two service items at the bottom:

| Route | Screen | Nav item | Requirements |
| --- | --- | --- | --- |
| `/` | redirects to `/chat` | — | — |
| `/chat`, `/chat/:threadId` | Chat | `Chat` | SLK-01…SLK-07, DSP-01, DSP-04…DSP-07, WRK-04, WRK-05 |
| `/overview` | Overview | `Overview` | DSP-08, DSP-09, ADM-01, NFR-03 |
| `/tasks` | Tasks | `Tasks` | ADM-01, DSP-05 |
| `/tasks/:taskId` | Task detail | `Tasks` | ADM-02, WRK-01…WRK-11, CI-01…CI-09, ST-03 |
| `/sessions/:sessionId` | Session console | `Tasks` (or `Chat` for the dispatcher session) | ADM-03, ADM-04, ADM-06 |
| `/config` | Config & limits | service | ADM-05, PRF-01…PRF-04, NFR-03 |
| `/connections` | Connections | service | CTX-01…CTX-05, SEC-04 |
| any other path | Not found | — | — |

The shell on every screen:

- The product name `Jarvis` and the `LOCAL · NO AUTH` badge (ADM-07).
- A compact `Usage meter`: `notional $X.XX / $Y.YY today` and a bar. Clicking it goes to `/config`.
- An engine connection indicator: `Live`, `Reconnecting…`, `Offline`.
- A counter of what is waiting on the owner: questions, spec/plan approvals, permission requests.
  Clicking it goes to the oldest such thread.
- A full-width `Paused: daily budget reached` banner when the limit is exhausted (see "Global states").

## Screens

### Chat — `/chat`, `/chat/:threadId`

**Goal.** The main working screen: submit a task, hold the conversation, make decisions. Covers SLK-01…SLK-07,
DSP-01, DSP-04…DSP-07, WRK-04, WRK-05, SEC-01.

**Blocks:**

1. **Thread list** (left column). Each row: the first words of the message, a `Task Stage` badge (if there is a task),
   time of last activity, a "waiting for you" marker. At the top, a `New thread` button and an `All · Waiting for me · Active · Done` filter.
   Sorting: threads waiting on the owner first, then by last activity.
2. **Thread** (center). Header: thread title, links to the task (`T-12 →`) and the PR (`PR #34 ↗`), stage badge.
   Below it, a chronological feed of messages.
3. **Input field** at the bottom of the thread. Text, `Send`, a hint "Enter — send, Shift+Enter — new line".
   While the dispatcher is processing the previous message, a new one can be written: it is placed in the queue with a `queued` marker.
4. **Empty state with no thread selected:** a "Describe a task or ask a question" field and a few examples
   ("Add a course curriculum page from the design…", "What does Notion say about…").

**Message types in the feed:**

| Type | Content | Actions |
| --- | --- | --- |
| `Owner message` | Owner's text, time, `queued` / `delivered` marker | — |
| `Jarvis message` | Agent text in Markdown, links to artifacts, the PR, sources | — |
| `Status card` | One message that updates in place (SLK-07): stage, steps with checkmarks (`✓ context`, `✓ spec`, `… implementing 3/5`), attempt counters (`checks 2/3`), time since start | `Open task →`, `Open console →` |
| `Decision card` | Spec and plan for approval (WRK-04): a short summary, links to `spec.md` and `plan.md` | `Approve`, `Request changes` (opens a comment field) |
| `Question card` | A worker question (WRK-05) with options or a free-form answer | option buttons, `Answer` |
| `Permission card` | A permission request (SLK-05, DSP-09): who is asking (the dispatcher or worker `T-12`), tool, description, input data (collapsed if long) | `Allow`, `Deny` |
| `Result card` | Draft PR opened, CI result, final summary (WRK-09, CI-03, CI-08) | `Open PR ↗`, `Open result.md` |
| `System line` | A service event: "Task queued — starts when a worker is free", "Worker restarted from stage Implementing", "Cancelled" | — |

After an answer, decision, question and permission cards become inactive and show what was chosen, by whom and when
(`Approved · 14:32`). A card cannot be answered twice.

**Thread actions (the `⋯` menu):** `Status` (DSP-05), `Cancel task` (DSP-06, with confirmation), `Open task`, `Open dispatcher session`.

**States:** empty thread list; thread loading; the dispatcher is "thinking" (an indicator under the last message);
send failure (a message with `Retry`); thread without a task (a knowledge question, DSP-07); budget exhausted
(the input field stays active, but above it an explanation that new tasks will be queued); engine unavailable
(the input field is disabled, with the message "Engine offline — messages can't be sent").

### Overview — `/overview`

**Goal.** Understand at a glance what is happening right now. An analog of Mission Control from Agent Ops Center.
Covers DSP-08, DSP-09, ADM-01, NFR-03.

**Blocks:**

1. **KPI row:** `Workers busy N/max`, `Queue N`, `Waiting for you N`, `PRs open N`, `Usage today $X / $Y`.
2. **Dispatcher.** The dispatcher session card: status (`Idle`, `Running`, `Waiting for permission`, `Error`),
   current action (tool and argument, or "Thinking"), duration of the current run, a link to the console.
3. **Workers.** A card per worker slot; the number of cards equals `maxConcurrentWorkers`. A busy slot:
   the task (`T-12` and title), the stage with a `Context · Spec · Impl · Verify · Review · PR` stepper, current action, duration,
   attempts (`checks 1/3`), the run's notional cost, `Console →`. A free slot: "Free".
   The "stuck" state is marked separately: no events for over 10 minutes, or waiting for permission (DSP-09).
4. **Queue.** Tasks and events waiting for a free slot: what exactly (a new task, a CI event, an owner reply), and since when.
5. **Watching.** Tasks in `PR Open` and `Blocked` that occupy no slot: the PR, CI state, review state, the time of the watcher's
   last check, next check in N s.
6. **Event log.** A combined feed of events across all tasks, newest first, with a filter by task and type
   (`stage`, `ci`, `review`, `permission`, `error`) and a pause, as in Mission Control.

**States:** nothing happening (all slots free, the queue empty, "Jarvis is idle"); paused over budget
(worker cards show `Paused`, the queue does not move); engine unavailable.

### Tasks — `/tasks`

**Goal.** The list of all tasks. Covers ADM-01, DSP-05.

A table: `ID`, `Title`, `Stage`, `Waiting for` (`owner`, `CI`, `review`, `worker slot`, `—`), `Branch`, `PR`,
`CI` (the aggregated state of the current commit), `Runs`, `Notional $`, `Updated`. Filters by stage
(`Active · Waiting · Done · Failed · Cancelled`) and search by title or ID. Clicking a row opens Task detail.

**States:** empty ("No tasks yet. Submit the first one in Chat", with a link); loading; error.

### Task detail — `/tasks/:taskId`

**Goal.** Everything about one task in one place: what has been done, what is happening now, what comes next.
Covers ADM-02, ADM-06, WRK-01…WRK-11, CI-01…CI-09, ST-03, ST-05.

**Blocks:**

1. **Header.** ID, title, stage badge, `Waiting for`, the `jarvis/T-12` branch, the PR link, a link to the thread,
   time since start, total notional cost. Actions: `Retry stage`, `Stop worker`, `Cancel task` (with confirmation).
2. **Stage timeline.** The stages `Intake → Context → Spec Review → Implementing → Verifying → Reviewing → PR Open → Fixing → Done`
   with entry and exit times. Repeats (for example, returning from review to `Fixing`) are shown as separate segments.
   The terminal `Blocked`, `Failed`, `Cancelled` carry a reason.
3. **Artifacts.** Tabs `context.md`, `spec.md`, `plan.md`, `tasks.md`, `result.md`. Markdown is rendered,
   source links are clickable. For `tasks.md`, the checkboxes show subtask status. A file not yet created
   has an empty state "Not written yet — appears at stage X".
4. **PR · CI · Review.** The PR link, the current commit (short SHA). The list of this commit's CI checks:
   name, status (`queued`, `running`, `passed`, `failed`, `skipped`), duration, log link. Earlier commits are
   collapsed under `Earlier commits`. Review state: `Pending`, `Changes requested`, `Approved`, reviewer comments
   (author, text, whether Jarvis has handled them). Round counters: `CI fixes 1/2`, `Review rounds 0/3`.
5. **Runs.** A table of the task's CLI runs: role (`dispatcher`, `worker`, `reviewer`, `plan verifier`), stage,
   start, duration, status (`running`, `completed`, `failed`, `stopped`, `limit reached`), tokens, notional $.
   Clicking opens the Session console at that run.
6. **Journal.** A chronological journal of the task's events (ST-03): stage changes, messages, CI and review events,
   owner actions from the admin panel (ADM-06) with a `by owner` marker.

**States:** the task does not exist (Not found); the task is active (blocks update live); `Failed` (the reason at the top,
the latest attempts, a `Retry stage` button); `Cancelled` (actions disabled, the branch and PR remain links).

### Session console — `/sessions/:sessionId`

**Goal.** A live, structured view of a Claude session: what the agent writes, which tools it calls, what they
return. An analog of the Agent console and Session Log from Agent Ops Center, but on real stream-json events.
Covers ADM-03, ADM-04, ADM-06.

**Blocks:**

1. **Header.** The session's role, task or thread, model, status (`Running`, `Idle`, `Waiting for permission`, `Stopped`, `Error`),
   the CLI session ID, the number of runs.
2. **Run selector.** The list of the session's runs; by default the current or the latest one.
3. **Run summary.** Tokens (`input`, `output`, `cache read`, `cache write`), `total_cost_usd` as notional $,
   duration, number of turns relative to `max turns per run`.
4. **Event stream.** Events in order:
   - agent text (Markdown);
   - a tool call: name, input data (collapsed), result (first lines, `Show more`), `ok` / `error` status, duration;
   - a permission request and the decision on it;
   - system events (process start, `resume`, end of turn, process exit with a code);
   - CLI errors.
   While a run is in progress, new events are appended at the bottom. If the owner scrolls up, autoscroll turns off
   and a `Jump to latest` button appears.
5. **Filters and search.** `All · Messages · Tool calls · Errors · System`, text search, jumping between errors.
6. **Control panel** (ADM-06):
   - `Send message` — an input field. The message is queued and goes into the session on the next turn (`--resume`). In the feed it
     shows as `queued`, then as delivered.
   - `Stop run` — stops the current CLI process, with confirmation.
   - `Retry stage` — restarts the task's current stage from the artifacts.

**States:** a session with no runs yet; a run finished with an error (the reason at the top); the process is stuck (no events for over
10 minutes, a warning); the session is stopped; budget exhausted (`Send message` and `Retry stage` disabled with an explanation).

### Config & limits — `/config`

**Goal.** Show which rules Jarvis works by and how much of the limit has already been spent. Read-only:
values are changed in the config file. Covers ADM-05, PRF-01…PRF-04, NFR-03.

**Blocks:**

1. **Usage.** `notional $X.XX of $Y.YY today`, a bar, the reset time, a breakdown by role (`dispatcher`, `worker`,
   `reviewer`, `plan verifier`) and by task. A warning at 80% and the `Paused` state at 100%.
2. **Limits.** A "parameter — value — what it means" table: `maxConcurrentWorkers`, `checkRetries`, `ciFixRounds`,
   `reviewRounds`, `taskTimeout`, `maxTurnsPerRun`, `dailyBudgetUsd`, `watcherPollInterval`, the models for each role.
   The path to the config file and the time it was last read.
3. **Repository.** The working repository, the default branch, the check and dev-server commands from the repository's
   `AGENTS.md` (CON-04). If `AGENTS.md` lacks the needed commands, a warning.
4. **Profile.** Read-only contents of `SOUL.md` and `USER.md`, the file paths, the time of the last change (PRF-03).
5. **Allowlists.** Reviewers whose comments are processed (CI-06); commands allowed without a prompt (SEC-01).

**States:** the config cannot be read or is invalid (an error with the line and field; Jarvis does not start tasks).

### Connections — `/connections`

**Goal.** Verify that everything needed is connected, and that Jarvis is not paying for the API. Covers CTX-01…CTX-05, SEC-04.

A row per connection: name, status (`Connected`, `Not configured`, `Error`), details, check time, `Check again`.

| Connection | What we show |
| --- | --- |
| Claude CLI | Version, subscription login (`Logged in · Max`), or `Not logged in` with a `claude login` instruction. **A red warning** if `ANTHROPIC_API_KEY` is set: in that case the CLI pays for the API instead of using the subscription |
| GitHub | The bot account Jarvis pushes and opens PRs from; access to the working repository; token permissions (`contents`, `pull requests`, `checks`/`actions` read); token expiry. The token itself is never shown (SEC-04) |
| Notion | Access to the root page from the config |
| Google Docs | Access to the folder or document from the config |
| Claude Design | Whether the design handoff is available (CTX-01) |
| Slack | `Iteration 2`, the row is inactive |

**States:** a check in progress; a check failed with the reason text; everything connected.

## Shared components

| Component | Where it is used | What it must do |
| --- | --- | --- |
| `Message bubble` | Chat | Author, time, Markdown, `queued` / `delivered` / `failed` state |
| `Status card` | Chat | Update in place, a list of steps with checkmarks, attempt counters, links |
| `Decision buttons` | Decision card, Question card | Primary and secondary action, inactive state after an answer with a caption of who and when |
| `Permission card` | Chat, Session console, Overview | Who is asking, the tool, description, collapsed input data, `Allow` / `Deny`, a summary after the decision |
| `Stage badge` | Everywhere a task appears | All `Task Stage` values; terminal states differ not only by color but also by a symbol or a word |
| `Stage stepper` | Overview, Task detail | The current stage, completed ones, upcoming ones; repeats |
| `CI check row` | Task detail, Overview | Name, status, duration, log link |
| `Run event row` | Session console | The event types from the list above, collapsing long output |
| `Usage meter` | Shell, Overview, Config | Compact and full variants, warnings, `Paused` |
| `Artifact viewer` | Task detail, links from chat | Markdown, checkboxes, a "not created yet" empty state |
| `Connection row` | Connections | Status, details, `Check again` |
| `Empty state` | All lists | An explanation and the next action |
| `Connection banner` | Shell | `Reconnecting…` and `Offline` with the time of last contact |

## Global states

- **Live updates.** Data arrives over SSE. New messages, stage changes and console events appear without a reload.
- **Disconnected.** If the connection to the engine is lost, the shell shows `Reconnecting…` and data-changing actions are disabled.
  After reconnecting, the UI catches up on missed events.
- **Budget paused.** When the daily limit is exhausted: a banner in the shell, workers `Paused`, new tasks queued, launch buttons
  (`Retry stage`, `Send message` in the console) disabled with an explanation and the reset time. Chat stays available.
- **Loading** and **Error** for every screen and block separately: one block's error does not break the page.

## Edge cases

| Case | What the UI shows | Requirement |
| --- | --- | --- |
| Two simultaneous permission requests from different workers | Two separate cards in the corresponding threads; the "waiting for you" counter = 2 | SLK-05, DSP-09 |
| The owner clicked `Allow` twice or in two tabs | The second click does nothing; the card shows the first decision | SLK-05 |
| An answer to a question arrives when the task is already `Cancelled` | The card is inactive with a "Task cancelled" explanation | DSP-06 |
| A third task while the slots are busy | A `System line` "Queued — position N", the task appears in Overview → Queue | DSP-08 |
| A worker is silent for over 10 minutes | A warning on the worker card and in the thread | DSP-09 |
| Very long tool output (thousands of lines) | The first lines, `Show more`, no page freeze | ADM-04 |
| A run ended due to `max turns` | A `limit reached` status and an explanation of what Jarvis does next | WRK-11 |
| CI rerun on the same commit | Check rows update in place, the old result goes under `Earlier attempts` | CI-07 |
| A PR comment from a non-allowlist author or a bot | Shown with an `ignored` marker | CI-06 |
| An artifact changed while open | It updates with an `Updated just now` marker | ADM-02 |
| Text from Notion or a PR contains HTML or "instructions" | Shown as text, without executing markup or scripts | SEC-03 |
| `ANTHROPIC_API_KEY` in the environment | A red warning on Connections and in the shell | CON-01 |
| The config is invalid | Config shows the error; Chat explains that tasks do not start | — |

## Open design questions

- [ ] Are Chat and Overview separate screens, or is Chat paired with a right-hand worker status panel? This determines whether
  the owner sees progress without switching.
- [ ] Does the Session console open as a separate page or as a side panel over Chat and Task detail?
- [ ] Should the thread show the agent's intermediate messages, or only the `Status card` and decision cards (less noise, but less visibility)?
- [ ] How to mark the dispatcher session in the thread list: a separate service thread or only a link from each thread?
- [ ] Is a dark theme needed in iteration 1?
- [ ] Is a global `Stop all` needed for the case when the agent is doing something wrong?
