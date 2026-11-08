---
status: accepted
date: 2026-11-08
decision-makers: [] # owner: a ui-tester subagent on sonnet, scenarios from spec.md, works on laptop and server (2026-11-08); drafted by Claude
scope:
  [
    'agent/agents/ui-tester.md',
    'agent/prompts/worker.md',
    'shared/src/config.ts',
    'shared/src/mcp.ts',
    'engine/src/application/ui/**',
    'engine/src/application/ports/dev-server.ts',
    'engine/src/infrastructure/dev-server/**',
    'engine/src/infrastructure/claude/**',
    'docker/runtime/Dockerfile',
    'jarvis.config*.json',
  ]
supersedes: []
superseded-by: []
---

# ADR-0022: Verify a UI change in a real browser through Playwright MCP, driven by a `ui-tester` subagent against an engine-leased dev server

## Context and Problem Statement

A worker takes a change to a draft PR on the strength of the target repository's own checks — tests,
lint, typecheck. For a UI change that is weak evidence: a suite can be green while the button does
not click, the page throws on hydration or the layout has collapsed. The owner finds out by pulling
the branch and starting the dev server themselves, which is the most expensive step of review and
the one Jarvis exists to remove.

WRK-10 in `agent/prompts/worker.md` already specifies the behaviour, conditional on "if a browser
tool is available". No browser tool exists, so the condition never holds and every UI PR carries the
same honest note that nothing was checked.

Giving an agent a browser raises two problems that matter more than the browser itself:

- **A loop with no floor.** A model that can navigate, click and screenshot can keep doing it. The
  existing brakes (`maxTurnsPerRun`, `maxBudgetUsdPerRun`, `taskTimeoutMinutes`) bound a run, not a
  browsing session, and they bound it expensively.
- **A process the engine does not own.** A dev server started by the agent through `Bash` has
  nothing to stop it: it survives the run, holds the port and is invisible to the engine.

## Considered Options

- **Keep WRK-10 unsatisfiable.** No browser; the owner checks the UI. Status quo.
- **Playwright MCP given to the worker directly.** One server in the run's `mcp.json`; the worker
  navigates between its other work.
- **Playwright MCP given to a `ui-tester` subagent, with the dev server owned by the engine.**
- **A new `UI Check` stage in the task state machine**, with its own run, prompt and limits.

## Decision Outcome

Chosen option: **a `ui-tester` subagent plus an engine-owned dev server**. Confirmed by the owner
(2026-11-08): a subagent rather than a new stage, scenarios derived from `spec.md`, and it must work
both on the laptop and in the runtime container.

- **`agent/agents/ui-tester.md`**, `model: sonnet`, tools `Read, Glob, Grep` plus the browser. No
  `Bash`, no `Edit`, no `Write`: it looks and reports, it does not fix or start anything. Its
  contract is a verdict (`pass` / `fail` / `inconclusive`), a result per scenario with a screenshot,
  and findings. Keeping the browsing in a subagent keeps dozens of snapshot-sized tool results out
  of the context of the run that then has to write the PR.
- **The scenarios come from `spec.md`'s acceptance criteria**, not from the model's imagination.
  That is what makes "is it finished" answerable, and therefore what makes the check terminate.
- **`ui.devCommand` is config, never an argument.** `start_dev_server` and `stop_dev_server` take a
  strictly empty object. The engine runs the command in the task's own worktree as a detached
  process group, waits for `ui.readyPath` to answer, and holds one lease engine-wide. The lease
  expires after `ui.leaseMinutes`; the engine then kills the process group. It also kills it when
  the run ends, when the engine shuts down, and on start-up if a previous engine left one behind.
- **`--allowed-origins` is set to the dev server's origin alone.** Playwright MCP's own help says
  this is not a security boundary and does not cover redirects, so it is a brake, not a boundary.
- **`browser_evaluate`, `browser_run_code_unsafe` and `browser_file_upload` are denied.** A UI check
  does not need page JavaScript, and `browser_evaluate` would let the agent satisfy a scenario by
  calling the click handler directly — proving nothing about the UI. `--no-webmcp` stops a page from
  registering tools of its own, which SOUL principle 4 requires.
- **The version is pinned** (`@playwright/mcp@0.0.84`). `@latest` in an agent runtime makes a run
  non-reproducible.
- **A UI blocker reuses `limits.reviewRounds`.** The check sits inside `Reviewing`, so sending the
  task back to `Implementing` already spends a round and already ends in `rounds_exhausted`. No new
  counter, no migration.
- **Chromium ships in `docker/runtime` under `/ms-playwright`**, and
  `PLAYWRIGHT_BROWSERS_PATH` is added to the inherited child environment, because the MCP server is
  a grandchild (engine → `claude` → MCP server). `ui.noSandbox` adds `--no-sandbox`, which the
  container needs and the laptop does not.
- **`ui.enabled` defaults to `false`.** The engine tells the worker which it is in the run context
  (`uiCheck: available` / `disabled: <reason>`), so the model never has to infer why the browser is
  silent and never tries to arrange one.

"Playwright MCP to the worker directly" was rejected for the context cost and because the worker
would then also own the dev server process. "A new `UI Check` stage" was rejected as the expensive
version of the same thing: a domain change, a migration and a second prompt, for visibility that
`post_update` and the journal already give.

### Consequences

- Good: a UI PR now carries evidence a person can look at, and the brakes on it are enforced by the
  engine and the CLI rather than by the model's willingness to stop.
- Good: the dev server is a process the engine starts, leases and kills, like the worktrees.
- Bad: the runtime image grows by roughly 400 MB, and the VPS provisioning gains a step.
- Bad: `ui.devCommand` is global while a task may target another repo (ADR-0019) — the same limit
  `allowlist.autoAllowedCommands` already has. The owner edits the config to switch.
- Bad: `npx -y @playwright/mcp@0.0.84` reaches the npm registry (or its cache) on a run that starts
  cold. An offline host will see the browser fail to come up, which the worker reports as
  `inconclusive` rather than as a silent pass. Vendoring it as a repository dependency is the open
  follow-up.

## More Information

- `docs/specs/ui-verification.md` — the feature spec and its acceptance criteria.
- ADR-0023 — how the screenshots reach the PR.
- `npx @playwright/mcp@0.0.84 --help` and its `tools/list`, read on 2026-11-08.
