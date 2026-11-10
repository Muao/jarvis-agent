# Run retrospective: a workflow retro after a long task

**Status:** draft (2026-11-09) · **Author:** owner + Jarvis · **Stage:** after a task ends (Done / Failed)

After a long task — five or more worker runs — Jarvis looks back at how the runs went: where the
tokens were well spent, where they were wasted, and what would make the next task cheaper. It always
posts a short report in the task's thread; the significance threshold only decides how a proposal is
ranked — significant ones lead, minor ones are a line at the end.

## 1. Why

A feature that takes five or more runs has usually hit something: a check that failed three times, a
permission card nobody answered for half an hour, a run cut off at `max_turns` and restarted, a review
loop that went the full `reviewRounds`. The recorded data to see this already exists, but nobody looks
at it: the owner opens the usage page, sees a big number, and cannot tell which part of it was
avoidable. The subscription is a shared, finite resource (CON-02), and the limits in
`jarvis.config.json` (LIM-03/04) are guesses made before any real run. A retro turns "the task was
expensive" into "this was the part that was wasted, and this change would have removed it".

The owner's rule on noise: a proposal projected below 15–20% of the task's token spend is not
significant. It may still be mentioned, but briefly and clearly labelled minor — a report where
micro-optimizations are dressed up as findings trains the owner to ignore it.

## 2. Scope

**Goals**

- After a long task ends, the owner gets one short report in the task's thread: what went well, what
  was wasted, and zero or more concrete proposals.
- Every proposal states its projected saving and what the projection is based on, honestly marked as
  an estimate.
- Every proposal is classified by `retro.significantSavingsPercent`: at or above it, significant and
  presented in full; below it, minor and at most one line. The report itself is always posted.
- The retro costs a bounded amount, never runs on itself, and is off until the owner turns it on.

**Non-goals**

- No per-subagent breakdown. Subagents run inside the worker's process and their tokens land in the
  parent run's totals (STATUS.md, known gaps). The retro works with per-run totals, stop reasons,
  turns and journal events, and says so when a conclusion would need more.
- No re-reading of the whole transcript of every run. Recorded data first; a transcript is read only
  for a specific, named question the data cannot answer (see 4.3).
- No automatic changes in iteration one. Proposals are text; the owner applies them (see 5 and
  question 3).
- No cross-task statistics ("over the last 20 tasks…"). One task, one report. A trend view is a later
  extension.
- No retro for tasks of kind `ui_check` (ADR-0018): they never reach five runs by design, and the
  threshold would only be hit by a fault worth a different report.

**Anti-goals** — things that make the feature a failure even if it technically works

- A retro that spends a visible fraction of what it analyzes. A retro whose cost exceeds the savings it
  could ever find is a net loss.
- A retro of a retro, or a retro triggered by a retro's own runs.
- Padding: three proposals of 3% each phrased to look like a finding.
- A projected saving presented as a measurement. Nothing here is a bill (ADR-0005); it is an estimate
  from estimates.
- Changing the owner's config, prompts or `USER.md` without the owner's approval.

## 3. Owner decisions (2026-11-09)

| Question | Decision |
|---|---|
| When to run | After a long feature implementation: five or more steps |
| What it looks at | What went well in token terms, what went badly, how the runs could be improved |
| What it proposes | Ideas for improvement |
| What counts as significant | The 15–20% threshold only classifies a proposal as significant or minor; the report is posted in any case (2026-11-09) |
| Unit of the percentage | Tokens, not estimated cost (2026-11-09) |
| How it executes | A new `retro` run role — decided in ADR-0020 (2026-11-09) |

Everything below that is not in this table is the spec author's call and is marked **(default)**.

## 4. How it behaves

### 4.1 When it triggers

The retro is queued when a task enters a terminal stage and **all** hold:

1. `retro.enabled` is `true`.
2. The task is of kind `build` (the only kind that exists besides `ui_check`, ADR-0018).
3. The task has at least `retro.minRuns` worker runs recorded (**default 5**). "Worker run" means a
   run of the worker role, whatever its outcome; dispatcher runs and the retro's own run do not count.
4. The terminal stage is `Done` or `Failed` **(default)**.
5. No retro has been produced for this task before.

`Failed` is included on purpose: a task that burned five runs and died is where most of the avoidable
spend lives. `Cancelled` is excluded **(default)**: the owner stopped it, usually for reasons the data
does not show, and the recorded runs end mid-flight, so "waste" would be mostly an artifact of the
cancel. See question 2.

The retro runs after the task is closed, in the background of the owner's attention: it does not hold
the worker slot (`limits.maxConcurrentWorkers`) against the next task, and at most one retro runs at a
time engine-wide (ADR-0020).

### 4.2 What it analyzes

All from recorded data of the one task:

| Signal | Where it comes from |
|---|---|
| Spend per run and per stage: tokens, estimated cost, per model | usage recorded per run (the same data the usage query groups by task and model) |
| How each run ended | the per-run stop reason (`max_turns`, budget, error, normal) and turn count |
| Retries actually consumed | counters against `limits.checkRetries`, `ciFixRounds`, `reviewRounds` |
| Repeated stages | the journal: stage transitions, `Reviewing → Implementing` returns, `rounds_exhausted` |
| Waiting that burned nothing but time | journal: permission cards and their wait, stalls (`stallMinutes`), parked/blocked periods, `dev_server` events |
| What the limits did | runs ended by `maxTurnsPerRun` / `maxBudgetUsdPerRun`, and whether the next run redid the lost work |

Dead time (waiting) is reported as time, not tokens: it costs the owner, not the budget. It can drive
a proposal (an allowlist addition) only through the tokens it indirectly wasted, e.g. a re-run caused
by a stall.

### 4.3 The savings rule

For each candidate improvement the retro computes a projected saving:

> projected saving % = (spend attributable to the avoidable part) ÷ (the task's total spend) × 100

- "Spend" is **tokens** (owner decision, 2026-11-09); the estimated cost is shown beside it as
  context. Tokens of different models are not strictly comparable, so when the runs involved used
  different models the report says so next to the percentage rather than pretending precision.
- "Attributable" is whatever the recorded data shows directly: the full token count of the runs a
  stall caused to be repeated, of fix rounds that a missing check in the prompt made necessary, of a
  run cut at `max_turns` whose work was redone. When the attribution needs a guess, the proposal says
  it is a guess and uses the **lower** end of its range for the threshold test.
- The threshold classifies, it does not censor: a candidate at or above
  `retro.significantSavingsPercent` (**default 15**; the owner said 15–20) is a **significant**
  proposal, presented in full; one below it is **minor** and gets at most one line. Exactly at the
  threshold counts as significant.
- Each included proposal carries: what to change, the projected saving as a percentage and an amount,
  and one or two lines on what the projection is based on (which runs, which journal events).
- A transcript is read only when a significant candidate's cause is unclear from the data, and only the runs and range named in the candidate. It is a bounded look, not a survey.

Savings do not add up by default: two proposals about the same runs are one proposal, and the report
does not claim a combined figure bigger than the spend they overlap on.

### 4.4 What the report contains

Posted into the task's thread, short enough to read in a minute:

1. **Header line:** task, number of worker runs, total estimated spend, wall-clock span.
2. **Went well:** at most three bullets, each backed by a figure (for example "checks passed first time
   in 4 of 5 runs"). Omitted if nothing stands out.
3. **Went badly:** the biggest waste items by tokens, each with the runs involved.
4. **Proposals:** significant ones first, ranked by projected saving and presented in full; minor ones
   after, one line each ("minor: …, ~4%"). Kinds the retro may propose: a worker-prompt change, a
   config or limit change, an allowlist addition that would have avoided a permission stall, splitting
   the task earlier. The retro describes the change; it does not apply it.
5. **If nothing significant was found:** the report still goes out, says "no change would have saved
   ≥ 15%; the run was in order", and lists the minor notes in a line or two.

The same text goes to a `retro.md` in the task's artifacts, and the journal records that a retro was
produced and how many proposals it contained.

### 4.5 Cost discipline

- The retro uses its own model, configured separately **(default: the cheapest model that can do
  analysis; the owner picks it)**, and its own run limits `retro.maxTurns` and `retro.maxBudgetUsd`.
  Both are enforced by the CLI, not by the retro's good behavior (ADR-0003, ADR-0005).
- The retro's cost is recorded like any other run's, and is **not** counted toward the analyzed task's
  total, nor does it count toward `retro.minRuns` of any task. It does count toward `dailyBudgetUsd`.
- A retro never produces another retro: its runs are excluded from the trigger by rule (4.1.3), not by
  the retro remembering not to.
- If the daily budget is exhausted, no retro starts (see edge cases).

## 5. Persistence

Iteration one is **report-only**: the report in the thread and `retro.md`. Nothing is written to
`USER.md`, `jarvis.config.json` or the agent prompts. If the owner likes a proposal they say so in the
thread and the dispatcher handles it as any other request — a config patch already goes through
`update_config` and its `FORBIDDEN_PATHS` (ADR-0013), a learned fact through `remember`. The retro adds
no new write path. Whether accepted proposals should later be applied by the retro itself is question 3.

## 6. Config

A new block in `JarvisConfigSchema`, strict, every field with a default, absent block = disabled
(like the `ui` block):

```jsonc
"retro": {
  "enabled": false,                    // off until the owner turns it on
  "minRuns": 5,                        // worker runs a task needs before a retro is considered
  "significantSavingsPercent": 15,     // token share that makes a proposal significant (minor below)
  "model": "...",                      // the retro's own model; falls back to a cheap default
  "maxTurns": 20,                      // the retro's own run caps, enforced by the CLI
  "maxBudgetUsd": 0.5
}
```

- `minRuns` and `significantSavingsPercent` are positive; `significantSavingsPercent` is at most 100.
- The block is hot-reloadable like the rest of the config. A retro already running keeps the values
  it started with.
- Whether `retro.*` may be patched through `update_config` is not decided here; no field of it arms
  anything the engine executes, so the default is **allowed** except `retro.enabled`, which the owner
  flips by hand **(default)**. See question 5.
- All fields go into `jarvis.config.example.json`.

## 7. Contracts and interactions

- **Usage and run records:** read-only. The retro needs the per-run stop reason, turns, model and cost,
  already recorded per run. No new measurement is required of the CLI.
- **Journal:** read-only for analysis; the retro adds one event ("retro produced") to it.
- **Task thread:** one new message kind, the report. The web UI shows it like a status update; no new
  screen.
- **Worker slot and queue:** a retro must not delay the next owner task. ADR-0020 decides the how: a
  new `retro` run role over an engine-precomputed input file, no worker slot, one retro at a time.
- **Limits:** the retro is subject to `dailyBudgetUsd` and the supervision timers, like any run.
- **Untrusted content (ADR-0017):** journal and transcript text can contain text from PRs, CI logs and
  connectors. The retro reads it as data; a proposal never originates from an instruction found in it.

## 8. Acceptance criteria

**Trigger**

- RR-1. If `retro` is absent from the config, then the config is valid, `retro.enabled` is `false`,
  and no retro ever runs.
- RR-2. If `retro.enabled` is `true`, a `build` task reaches `Done` or `Failed`, and it has at least
  `retro.minRuns` worker runs, then exactly one retro is started for it.
- RR-3. If the task has fewer than `retro.minRuns` worker runs, then no retro starts and nothing is
  posted.
- RR-4. If the task has exactly `retro.minRuns` worker runs, then the retro starts.
- RR-5. If the task ends `Cancelled`, then no retro starts.
- RR-6. If the task is of kind `ui_check`, then no retro starts.
- RR-7. If a retro was already produced for the task, then a later change in the task (for example
  reopened and closed again) does not start a second one.
- RR-8. If a run is a retro run, then it is not counted among the worker runs of any task and does not
  trigger a retro.

**Analysis and the savings rule**

- RR-9. If a candidate's projected saving is below `retro.significantSavingsPercent` of the task's
  total token spend, then it appears as at most one line, labelled minor, never presented as a
  significant finding.
- RR-10. If a candidate's projected saving equals `retro.significantSavingsPercent`, then it is
  classified significant.
- RR-11. If the attribution of a candidate is a guess, then the proposal says so, and the threshold
  test uses the lower end of the range.
- RR-12. Every significant proposal states the projected saving as a percentage and a token amount,
  and the runs or journal events it is based on.
- RR-13. If two candidates are about the same runs, then they appear as one proposal and the report
  claims no combined saving larger than the spend of those runs.
- RR-14. The report is posted whenever a retro ran, including when no candidate is significant; in
  that case it says that no change would have saved that much, and minor notes stay one line each.
- RR-15. The report names no per-subagent cost. If a conclusion would need one, the report says the
  data does not allow it.

**Report**

- RR-16. When a retro finishes, the task's thread holds the report and the task's artifacts hold
  `retro.md` with the same text.
- RR-17. The report contains the header line (runs, total spend, span) and, when anything reached the
  threshold, proposals ordered by projected saving, largest first.
- RR-18. When a retro finishes, the journal holds an event with the number of proposals.
- RR-19. The retro changes nothing in `jarvis.config.json`, `USER.md`, or the agent prompts.

**Cost discipline**

- RR-20. A retro run is started with `retro.model`, `retro.maxTurns` and `retro.maxBudgetUsd`, and no
  other model or limit.
- RR-21. The retro run's cost is recorded in usage, is excluded from the analyzed task's total, and is
  included in the day's spend for `dailyBudgetUsd`.
- RR-22. If the daily budget is exhausted when a retro is due, then the retro does not start, a line in
  the journal says why, and it is not retried automatically.

## 9. Edge cases

- **Zero usage rows** (usage recording was missing, or the task ran before it existed). Spend is
  unknown, so no percentage can be computed: the retro posts a one-line report "no usage recorded, no
  retro possible" and no proposals. It never invents a total.
- **Budget exhausted mid-retro.** The CLI stops the run at `retro.maxBudgetUsd`. If it produced no
  report, the thread gets one line saying the retro was cut off and what was reached; a half-written
  proposal is never posted. No second attempt.
- **The retro run fails or times out.** One line in the journal and the thread; the task is unaffected,
  it stays in its terminal stage.
- **Retro disabled while a retro is running.** The run finishes with the values it started with.
- **Engine restart before the retro ran.** The retro is due, not lost: after startup it is picked up
  once, subject to the same checks. A retro interrupted mid-run is not resumed (see above).
- **One enormous run dominates the spend** (for example one run is 80% of the cost). Then the saving
  threshold is easy to clear for a proposal about that run, and the retro still has to base it on what
  the data shows about that run, not on size alone.
- **Everything was spent well but the task was simply big.** The report says so; "the task was large"
  is not a proposal.
- **A limit change would have saved tokens but caused a failure elsewhere** (for example a lower
  `maxTurnsPerRun`). The retro states the trade-off in the proposal and does not claim the saving
  unqualified.
- **Waiting dominated, spend was small.** Reported as time; no proposal is made unless the tokens it
  cost cross the threshold.
- **Runs used different models** (tokens are not strictly comparable). The threshold still uses raw
  tokens (owner decision); the report names the models next to the percentage and shows the estimated
  cost beside it, so the owner can discount accordingly.

## 10. Decisions it relies on

- ADR-0003: the retro runs only through the `claude` CLI on the subscription.
- ADR-0005: limits and figures are estimates and brakes; the projected savings inherit that.
- ADR-0013: any follow-up change to config or `USER.md` goes through the existing owner-driven paths
  and their forbidden-path limits.
- ADR-0017: journal and transcript text is data.
- ADR-0018: task kinds; the retro applies to `build`.

- ADR-0020: how the retro executes — a `retro` run role over an engine-precomputed input file, no
  worker slot, one at a time, excluded from its own trigger by role.

## 11. Open questions

1. ~~Run role or dispatcher-side job?~~ **Decided**: ADR-0020 (2026-11-09) — a `retro` run role, no
   worker slot, one at a time.
2. **Should `Cancelled` tasks get a retro?** Excluded by default. Owner: decide after seeing the first
   few `Failed`/`Done` retros.
3. **Should accepted proposals be applied by the retro itself** (a line under `## Learned` in `USER.md`,
   a config patch through `update_config`)? Report-only for iteration one. If yes, the forbidden-path
   limits (ADR-0013) and an explicit owner approval per change must carry over. Owner: owner.
4. ~~Percentage on cost or on tokens?~~ **Decided by the owner (2026-11-09): tokens.** Cost stays in
   the report as context only; mixed-model runs are flagged next to the percentage (4.3).
5. **May `update_config` patch `retro.*`?** Proposed: yes except `retro.enabled`. Owner: owner.
6. **Does the usage record keep enough to attribute spend to a stage within a run?** Without it, a
   proposal about a stage inside a long run can only be based on journal timing. Owner: engine, after
   the first retro on real data.
7. **Which model is "cheap enough" for the retro,** and what `maxBudgetUsd` does a realistic five-run
   task need? Unknown until measured. Owner: owner, after the first live retro.
8. **Is `minRuns: 5` the right proxy for "long"?** A task of two very expensive runs may waste more
   than one of six cheap ones. Left as the owner's stated rule; a spend-based trigger is a possible
   later addition. Owner: owner.

## Sources

- `docs/specs/abstract-project-spec.md` — pipeline, LIM-03/04, CON-02, ST-03 (journal)
- `docs/specs/ui-verification.md`, `docs/specs/ui-check-on-demand.md` — style reference, `ui` block
- `STATUS.md` — known gaps: no per-subagent cost, cost arrives only at a run's exit
- `shared/src/config.ts` — `limits`, `models`; `engine/src/application/config/update-config.ts` —
  `FORBIDDEN_PATHS`
- ADR-0003, ADR-0005, ADR-0013, ADR-0017, ADR-0018
