---
status: proposed
date: 2026-11-09
decision-makers: [] # owner: asked for this ADR and set the rules — report always, threshold classifies only, tokens as the unit (2026-11-09); drafted by Claude
scope:
  [
    'shared/src/enums.ts',
    'shared/src/mcp.ts',
    'shared/src/config.ts',
    'engine/src/application/runs/**',
    'engine/src/application/retro/**',
    'engine/src/infrastructure/claude/**',
    'agent/prompts/retro.md',
  ]
supersedes: []
superseded-by: []
---

# ADR-0020: The retrospective is a `retro` run role reading an engine-precomputed input

## Context and Problem Statement

The run-retrospective spec (`docs/specs/run-retrospective.md`) leaves one technical question open:
**what executes the retro?** After a long `build` task ends, something must turn the recorded data —
per-run usage, stop reasons, retries, journal events — into a short report with ranked proposals.
The spec's constraints: it must not delay the next owner task, must cost a bounded amount, must
never trigger itself, and must not be able to change anything.

The candidates differ in two dimensions: *who thinks* (an LLM run or engine code) and *under which
identity* (a new role, the dispatcher, or the worker).

## Decision Drivers

- The analysis has two unequal halves. The **arithmetic** — tokens per run, who hit `max_turns`,
  how many fix rounds were consumed — is deterministic and already sits in Postgres; paying model
  tokens to re-derive it is waste, and a model doing sums is also less reliable than SQL. The
  **interpretation** — "these two re-runs trace back to one permission stall; adding the check
  command to the allowlist would have saved ~31%" — is exactly what a model is for.
- Least privilege is already the house style: the dispatcher cannot edit files, a `ui_check` worker
  has no shell and no token (ADR-0018). A retro needs even less than either.
- Budget discipline comes from the CLI flags, not from prompt obedience (ADR-0003, ADR-0005).

## Considered Options

1. **A new `retro` run role** over an input file the engine precomputes.
2. **A dispatcher-side job** — reuse the dispatcher's run in the task's thread.
3. **Engine-only** — no LLM at all; the engine renders a numeric report from SQL.
4. **A worker run with a retro prompt** — reuse the existing role.

## Decision Outcome

**Option 1.** The split: the engine computes the numbers, the model reads them and writes the story.

### The input is precomputed, like a `ui_check` diff

When a task qualifies (spec 4.1), the engine writes `retro-input.md` into the task's artifacts
directory: the usage table per run (tokens per model, estimated cost, turns, stop reason), the
journal timeline (stage transitions, permission waits with durations, stalls, retries consumed
against their limits), and the task's totals. This mirrors the pattern just established for
`ui_check` (the engine precomputes `.jarvis/diff.patch` because the worker has no shell): the model
gets data as a file, not tools to go fishing with. No new MCP query tools, no DB access from the
agent, and the arithmetic in the report comes from code, not from a model's mental math.

### The role

- `RoleSchema` grows `'retro'`. Its toolset is the smallest yet: `post_update` (the report into the
  task's thread), `log_note`, `approve` — plus the CLI's own `Read` and `Write`. Everything else is
  denied the same way the dispatcher's editing tools are (`--disallowedTools`).
- The run's **cwd is the task's artifacts directory**, not a worktree: `retro-input.md` and the SDD
  artifacts are in reach, the repository is not. `retro.md` is written right there (spec 4.4).
- `buildChildEnv` gives a retro the narrowed base list and **no `GH_TOKEN`** — it talks to GitHub
  about nothing.
- The run is started with `retro.model`, `--max-turns retro.maxTurns`,
  `--max-budget-usd retro.maxBudgetUsd` (spec 4.5). Supervision timers and `dailyBudgetUsd` apply
  as to any run.

### Scheduling

- Queued by the engine on the task's terminal transition (the same place the trigger conditions of
  spec 4.1 are checked), after the task is closed — never instead of closing it.
- It takes **no worker slot**: it cannot touch a worktree or a repo, so it conflicts with nothing a
  worker does. Its concurrency brake is its own: **at most one retro runs engine-wide**, and further
  due retros wait in order. A retro lost to a restart is re-queued by the existing recovery sweep;
  one interrupted mid-run is not resumed (spec, edge cases).
- No recursion by construction: only `build` tasks trigger retros and a retro run carries the
  `retro` role, which the trigger's "worker runs" count never includes (RR-8).

### Why not the others

- **(2) Dispatcher-side job**: the dispatcher's prompt is routing and owner conversation; folding
  analysis into it bloats the prompt that runs on every thread message, entangles the retro's
  budget with the dispatcher's, and gives the retro the dispatcher's write tools (`update_config`,
  `remember`) — exactly what spec RR-19 forbids it to have.
- **(3) Engine-only**: honest about numbers but cannot do the one thing the owner asked for —
  propose ideas. It survives inside option 1 as the `retro-input.md` generator: everything
  deterministic stays engine-side.
- **(4) A worker run**: carries a worktree, project settings, `GH_TOKEN` and the full prompt of a
  code-writing agent — maximal privileges for a job that needs none of them, and WRK rules written
  for building would fight the retro's instructions.

### Consequences

- Good: least privilege by shape — no repo, no token, no config writes; a prompt-injection path
  into the retro (journal text quotes PR comments, ADR-0017) ends at "a skewed report".
- Good: the expensive part is bounded twice — the input is precomputed for free (SQL), and the
  model pass runs under its own small caps.
- Bad: a third role threads through the role plumbing — `RoleSchema`, `toolsByRole`, `run-args`,
  `child-env`, the scheduler, prompts — and each gets a `retro` case and tests. This is the cost of
  not overloading an existing role, and the `ui_check` work shows the seams are already there.
- Bad: `retro-input.md` is a second rendering of data the web usage page also renders; the formats
  can drift. Accepted: one is for a model, one is for the owner.
- Neutral: `agent/prompts/retro.md` is a new prompt carrying the spec's rules (threshold
  classifies, tokens as the unit, minor items one line, no combined-savings inflation).

## More Information

- Spec: `docs/specs/run-retrospective.md` (trigger, threshold semantics, report shape, ACs).
- Owner rulings folded in (2026-11-09): the report is posted in any case; the 15–20% threshold only
  classifies a proposal as significant or minor; percentages are computed on tokens.
- Open: whether the usage record can attribute spend to a stage within one run (spec question 6) —
  it changes `retro-input.md`, not this decision.
