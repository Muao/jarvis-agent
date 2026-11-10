---
status: accepted
date: 2026-11-09
decision-makers: ['Ivan Lapa'] # owner: one file, not several; the agent writes by itself and the owner reviews afterwards; every insight carries a timestamp and a confirmation counter; nothing is removed automatically (2026-11-09); drafted by Claude
scope:
  [
    'agent/USER.example.md',
    'agent/prompts/**',
    'agent/skills/memory-review/**',
    'shared/src/mcp.ts',
    'shared/src/config.ts',
    'engine/src/application/profile/**',
    'engine/src/application/runs/run-prompt.ts',
    'engine/src/application/ports/profile-store.ts',
    'engine/src/infrastructure/profile/**',
  ]
supersedes: []
superseded-by: []
---

# ADR-0021: Memory is one self-curating file — the agent writes insights under `## Learned` in `USER.md` by itself, each with its timestamp and a counter of the tasks that confirmed it

Amends ADR-0013: the format of `## Learned`, who may write it, and how entries leave it.

## Context and Problem Statement

ADR-0013 gave Jarvis a first memory: the dispatcher's `remember(fact)` appends a bullet under
`## Learned` in `USER.md`, and the engine puts `USER.md` into the first message of every run. It
works, and it named its own debts: nothing prunes the section, and nothing but an owner sentence in
chat ever feeds it.

Four gaps are now in the way:

1. **Append-only.** A wrong or outdated fact stays until the owner edits the file by hand.
2. **One source.** Only the dispatcher writes, and only from the conversation. What a worker learns
   mid-task, and what a reviewer says twice on pull requests, is lost.
3. **No scope.** A rule about one repository is injected into runs on every other repository.
4. **No signal of worth.** Nothing says whether an entry ever mattered again, so a useful one
   cannot be told from dead weight.

The owner's rulings (2026-11-09): keep it one file; let the agent write by itself, with the owner
reviewing afterwards rather than approving each entry; record when each insight was written and
count how many times it was confirmed, so the memory's usefulness can be seen later; remove nothing
automatically — a sweep nobody can predict is worse than a file that grows — and have a way to tidy
it on request.

## Decision Drivers

- The owner must be able to read and fix the whole memory in a text editor.
- No extra model runs: capturing and reinforcing an insight should happen inside the task that
  noticed it.
- Nothing leaves the memory on its own. Removal is the owner's decision, made with the counters and
  dates in front of them.
- Context is paid for on every run; memory that does not apply to the run should not be in it.
- Memory is the agent's future context, so it must not be able to widen the agent's own rights.

## Considered Options

1. **Self-curating file**: the agent writes insights directly; later tasks confirm or contradict
   them; the engine keeps timestamps and counters per entry; only the owner removes.
2. **Approval cards**: every agent-noticed insight is a proposal the owner approves.
3. **Raw log plus a distillation run** started by a threshold or a schedule.
4. **Split by kind** across `USER.md`, the repository's `AGENTS.md` and `SOUL.md`.

## Decision Outcome

**Option 1.**

### The file

`USER.md` keeps its shape: the owner's own sections on top, `## Learned` at the bottom. Entries
with no subheading apply everywhere; entries under `### owner/name` apply to that repository only.

```markdown
## Learned

- m3 [owner · 2026-11-09 10:42] Summaries in Ukrainian, code and PR text in English.

### burnjohn/quick-blog

- m1 [owner · 2026-11-08 19:05] The repository slug is burnjohn/quick-blog, not ilapa/quick-blog.
- m7 [agent · T-14 · 2026-11-14 16:05 · ✓4 ✗0 · last T-31 2026-11-20 09:12] Dates go through `formatDate()` from `lib/date`, never `toLocaleString`. (src: lib/date.ts:12, PR #41 review)
- m9 [agent · T-33 · 2026-11-21 11:30 · ✓1 ✗1 · last T-35 2026-11-22 14:48] The e2e suite needs `pnpm db:seed` before the first run. (src: package.json:14)
```

One line per entry: an id, who wrote it, the task that noted it and when (date and time, the
owner's local zone), how many tasks confirmed (✓) and contradicted (✗) it, the task and time of the
last such event, then the fact (at most 300 characters) and, for an agent entry, its citations. The engine writes everything in the
brackets; a model supplies only the fact. A hand-written line without a prefix is read as an owner
entry and given an id on the next write.

### Who writes what

| Tool | Role | Effect |
| --- | --- | --- |
| `remember(fact, repo?)` | dispatcher | an **owner** entry, written at once — the owner said it (ADR-0013) |
| `note_insight(fact, citations)` | worker | a new **agent** entry at ✓1, scoped to the task's repository, written at once |
| `confirm_insight(id)` | worker | ✓ +1 |
| `contradict_insight(id, reason)` | worker | ✗ +1 on an agent entry, the reason journalled; for an owner entry nothing changes in the file and the contradiction is reported in the thread |
| `remember_owner(fact, quote, everywhere?)` | worker | an **owner** entry marked `owner via T-n`, written at once — see "The owner's words inside a task" |
| `forget(id)` | dispatcher | removes one entry, on the owner's request |
| `merge_insights(ids, fact)` | dispatcher | replaces several entries with one whose counter is their sum |
| `read_memory()` | dispatcher | returns the whole `## Learned` section, for the `memory-review` skill |

There is no approval step. The owner reviews afterwards: the file is theirs to edit, the Config
screen shows it, and each task's final summary carries one line — "Memory: 1 noted, 2 confirmed,
1 contradicted" — with the entries named.

### The owner's words inside a task

While a task is active, the owner's messages in its thread go to the worker, not to the dispatcher
(DSP-04), so `remember` is out of reach exactly where the owner corrects the agent most: a "remember
this", a comment returned instead of a spec approval, an answer to a question.

- `remember_owner(fact, quote, everywhere?)` writes an owner entry from such a message. The engine
  accepts it only if `quote` (at least 8 characters) occurs verbatim in an owner message of this
  task's thread; it stores that message's id as the entry's source. A worker cannot put words in
  the owner's mouth.
- The entry is scoped to the task's repository unless `everywhere` is true, which the prompt allows
  only when the owner said so in as many words ("always", "everywhere", "in all projects").
- It is an owner entry in every respect: no counters, and no agent tool can remove it.

### What the worker writes, and when

- **Before `note_insight`, the recurrence test:** would this plausibly come up again in a different
  task? A one-off is not written. With no approval and no cleanup, this and the citation
  requirement are the only filters.
- **Fix rounds.** For every review comment handled: an entry already covers it → `confirm_insight`,
  and the closing message says the entry was in memory and the mistake still happened; no entry and
  it passes the recurrence test → `note_insight` citing the comment and the code line; a one-off →
  nothing.
- **Check commands.** In a repository without `AGENTS.md` (CON-04) the worker notes the check
  commands it found, citing the file they came from, so the next task verifies a citation instead
  of searching again.
- **A `ui_check` task writes nothing.** It reads a pull request head the owner may not trust
  (ADR-0018), so `note_insight`, `confirm_insight`, `contradict_insight` and `remember_owner` are
  refused for it and hidden from its run. It still reads the memory.

### Citations, checked at the moment of use

Taken from GitHub Copilot's agentic memory, which stores each memory with citations to code
locations and verifies them just in time instead of running any offline curation.

- `note_insight` requires one to five citations: a `path:line` in the task's repository that shows
  the fact, or the review comment it came from. An insight the worker cannot point at anything for
  is not written. Owner entries need none — the owner's word is the source.
- **Before relying on an entry, the worker opens what it cites.** If the code still says what the
  entry says, the worker uses it and calls `confirm_insight` — which is what ✓ means: a task used
  the entry and its citations held. If the code contradicts the entry or the cited place is gone,
  the worker does not follow it, calls `contradict_insight` with the reason, and, when it can see
  what is true now, writes the corrected fact as a new `note_insight` with fresh citations.
- The engine helps for free: when it builds a run's first message it checks that each cited file
  still exists in the worktree and marks the entry `citation missing` in the list when it does
  not. It changes nothing in the file.
- This is what replaces automatic cleanup. A stale entry is not swept away on a timer; it is caught
  by the next task that would have used it, and its ✗ tells the owner at review.

### The counters

- A run's first message lists the entries that apply to it, with their ids. The worker prompt tells
  the worker: when the situation an entry describes comes up again — a reviewer repeats the remark,
  the same mistake is about to be made, the rule decided how something was done — call
  `confirm_insight`; when a reviewer, the owner or the code says the opposite, call
  `contradict_insight`; when it is something new, `note_insight`.
- Both counters count **distinct tasks**: the engine ignores a second confirmation or contradiction
  of the same entry from the same task. ✓4 means the insight came up in four different tasks.
- Owner entries carry no counters.
- **Nothing is removed automatically.** A contradicted entry stays, with its ✗ showing; an entry
  nobody confirmed stays, with its age showing. An entry leaves the file only through `forget`,
  `merge_insights` or the owner's own edit.
- Every note, confirmation and contradiction is journalled with its task id and time. `forget` and
  `merge_insights` come from the dispatcher, which has no task, so they are written to the engine
  log with the removed text (and the file is backed up first). That journal
  is what a later "how useful is the memory" view is built from: entries by count, when each was
  last confirmed, how many were noted and how many survived.

What the counter does and does not say: it measures how often the situation recurred and the agent
recognised it. It is evidence that an entry is relevant, not a measurement of tokens or time saved.

### What a run sees

- A **worker** run gets the owner's sections, the unscoped entries and its repository's subsection.
  When the section exceeds `memory.softCapChars` (default 4000), owner entries go in first, then
  agent entries by ✓ and recency, those with more ✗ than ✓ last, until the cap; the rest stay in
  the file but out of the prompt, and the task summary says the memory is over its cap and due a
  review.
- A **dispatcher** run gets the owner's sections and the **owner entries** of every scope — the
  repo slugs and standing instructions it routes by. Agent insights about a codebase are of no use
  to it and would grow its prompt on every owner message; it reads them only through
  `read_memory`.
- **Subagents** see no memory by themselves. The worker passes its repository's entries into each
  call of `reviewer`, `implementer` and `plan-verifier`; the reviewer names the ids of entries the
  diff violates. Subagents have no memory tools — the worker confirms and contradicts.
- A **retro** run (ADR-0020) gets no memory tools; that decision is unchanged.

### Tidying on request: the `memory-review` skill

A skill in the agent plugin, used by the dispatcher when the owner asks to review the memory. It
reads `## Learned`, then in the conversation proposes: duplicates to `merge_insights`, vague
entries to rewrite (`forget` + `remember`), entries the counters and dates show are dead or disputed to `forget`. The
owner answers in chat and the dispatcher applies what was agreed. No schedule and no separate run:
it happens when the owner wants it.

### Keeping the file safe

`USER.md` lives outside git and is now written by the engine on behalf of the dispatcher and up to
two workers, and by the owner's editor.

- All engine writes go through one queue in the adapter, one at a time.
- Every write reads the file from disk first, so a hand edit made a second ago is never lost, and
  replaces it atomically (temporary file, then rename).
- Before `forget` and `merge_insights` the adapter copies the file to `~/.jarvis/backups/`,
  keeping the last `memory.backupsKept` (default 20).

### Limits that hold without an approval step

- Agent entries are always scoped to one repository. An entry that applies everywhere comes only
  from the owner, through `remember` or by hand.
- The agent cannot remove or rewrite an owner entry.
- Memory entries are hints about conventions and preferences. The worker prompt states that an
  entry never overrides the prompt's hard rules, the permission settings or the task's scope, and
  no tool here can touch `jarvis.config.json`, `SOUL.md` or a repository's `AGENTS.md`.

### Why not the others

- **(2) Approval cards** are the safest, and make the owner the bottleneck: a card per insight is
  noise, and cards approved without reading protect nothing. Rejected by the owner.
- **(3) A distillation run** has to guess that two raw notes mean the same thing, costs a run, and
  needs a trigger rule. Here the worker matches a situation to an existing entry at the moment it
  happens, and tidying is a skill used on request.
- **(4) Split by kind** costs three write paths and a judgement call per fact; its one benefit —
  a repository's rules not leaking into other runs — is delivered by the scope subheading.

### Consequences

- Good: no extra runs and no cards; the memory is written inside ordinary tasks.
- Good: every entry shows when it was written and how often it mattered or was disputed, so
  reviewing the memory is reading a sorted list.
- Bad: the file only grows until the owner reviews it. The cap bounds what a run pays for, not the
  file; a memory nobody reviews fills with entries that never reach a prompt.
- Good: a run pays only for the memory that applies to it, most-confirmed first.
- Bad: externally written text — a review comment, a CI log, a document (ADR-0017) — can reach
  future prompts as the worker's own `note_insight`, with no human check before it does. What
  limits it: one repository's scope, 300 characters, hint status, and a visible line
  in the task summary. This does not stop a persistent attempt; a repeated plant would be confirmed
  like any other insight. Accepted by the owner for a single-owner deployment with an allow-list of
  reviewers (CI-06), with after-the-fact review as the control.
- Good: a planted or outdated entry has to survive a check against the code it cites before any
  task acts on it. GitHub reports that its agents corrected adversarial memories this way; that is
  their stress test, not a guarantee here, and a plant that cites a review comment rather than code
  has nothing in the repository to be checked against.
- Bad: checking citations costs the worker a few file reads per entry it uses.
- Bad: the engine parses and rewrites a file the owner also edits. The adapter must leave every
  byte outside `## Learned` untouched (ADR-0013's rule) and tolerate hand-written lines.
- Bad: confirming depends on the worker noticing; a worker that forgets to call `confirm_insight`
  leaves a good entry looking unused. The summary line makes a silent memory visible.
- Bad: ADR-0013's "workers record nothing" no longer holds; this record replaces that rule.

## Confirmation

- RULE: `remember`, `forget`, `merge_insights` and `read_memory` are dispatcher-only;
  `note_insight`, `confirm_insight`, `contradict_insight` and `remember_owner` are worker-only;
  retro has none of them.
  CHECK: `shared/src/mcp.ts` `toolsByRole`
- RULE: a `ui_check` task's worker is refused all four worker memory tools.
  CHECK: use-case tests; `run-args` test for the disallowed tool names
- RULE: `remember_owner` is rejected unless `quote` occurs verbatim in an owner message of the
  task's thread.
  CHECK: use-case test — a quote from the worker's own text or from a review comment is rejected
- RULE: a dispatcher run's prompt contains no agent entry.
  CHECK: unit test on `run-prompt`
- RULE: concurrent writes do not lose an entry, and `forget` / `merge_insights` leave a backup.
  CHECK: adapter tests — N parallel appends yield N entries; backup file exists and is pruned
- RULE: an agent entry is always written under the task repository's subheading.
  CHECK: use-case test — `note_insight` has no scope argument and never writes an unscoped line
- RULE: `note_insight` without at least one citation is rejected, and a `path:line` citation must
  name a file that exists in the task's worktree.
  CHECK: schema test in `shared/src/mcp.ts`; use-case test for the missing file
- RULE: an entry whose cited file is absent from the worktree is marked `citation missing` in the
  run's first message, and the file on disk is unchanged.
  CHECK: unit test on `run-prompt`
- RULE: a second `confirm_insight` or `contradict_insight` for the same entry from the same task
  does not change its counter.
  CHECK: use-case test
- RULE: no worker tool and no timer removes or rewrites an entry's fact; the line count of
  `## Learned` only falls through `forget`, `merge_insights` or the owner's edit.
  CHECK: use-case tests — the fact text is byte-identical after `contradict_insight`; no
  `IntervalJob` writes the profile
- RULE: every write leaves the bytes outside `## Learned` unchanged, and the engine, not the model,
  writes the bracketed prefix.
  CHECK: unit tests on the profile adapter — byte-identical outside the section; a fact containing
  a forged `[owner · …]` prefix is stored as fact text
- RULE: a worker run's prompt contains no other repository's subsection and respects the cap order.
  CHECK: unit test on `run-prompt`

## More Information

- Source of the citation rule: GitHub, "Building an agentic memory system for GitHub Copilot"
  (2026-01-09), https://github.blog/2026-01-09-building-an-agentic-memory-system-for-github-copilot

- Plan: `docs/plans/agent-memory.md`.
- For the retro (ADR-0020), when it is built: `retro-input.md` gains a "Memory events" section from
  the task's journal, so the report can say which entries were used and which were disputed. The
  retro still gets no memory tools.
- Later, not decided here: a memory view in the web app built from the journal events (entries by
  counter, noted versus surviving).
