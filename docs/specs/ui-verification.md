# UI verification of a change before the PR

**Status:** draft (2026-11-08) · **Author:** owner + Jarvis · **Stage:** Reviewing

Before opening a draft PR, the worker must look at what it built with its own eyes: start the
application, walk through the `spec.md` scenarios in a browser, take screenshots, and embed them in
the pull request body.

## 1. Why

Today the pipeline takes a change to a PR on the strength of tests, the linter, and the typecheck.
For UI that is weak evidence: the tests can be green while a button does not click, the page crashes
on hydration, or the layout breaks. The owner finds out only when they open the PR themselves, pull
the branch, and start the dev server. In other words, the most expensive verification step rests on
a human.

Rule WRK-10 in `agent/prompts/worker.md` already demands exactly this behavior ("UI change: start the dev
server per `AGENTS.md`, open the page in a browser **if a browser tool is available**…"). The hole is
not in the prompt — the system has no browser tool, so the condition is never met, and every time the
worker legitimately writes "no browser was available" in the PR.

This specification closes the hole: it provides the tool, constrains it, and defines what exactly
counts as verification.

## 2. Scope

**Goals**

- The worker walks through the UI-related acceptance criteria from `spec.md` in a browser and gives
  a verdict for each one.
- Screenshots sit inline in the draft PR body, not behind links that have to be clicked.
- UI verification cannot become endless: it has a time lease, a scenario cap, and a cap on fix
  rounds, all imposed from outside the agent.
- Works the same on the laptop and in the container (`docker/runtime`), because the first live run is planned on the server.

**Non-goals**

- We do not write permanent e2e tests into the target repository. UI verification is evidence for one
  PR, not an artifact that stays in the code.
- We do not do visual regression (comparison against a baseline screenshot). No baseline — no point.
- The browser does not go to the external internet and does not log into third-party services.
- We do not build screenshot galleries in Jarvis's own UI (the owner chose the PR as the place to
  show them). That is a natural next extension, not part of this version.
- We do not check mobile viewports, accessibility (axe), or performance. There is room for them in
  `ui-tester`, but not in the first version.

**Anti-goals** — things that make the feature a failure even if it technically works

- The agent decides on its own which command to run as the dev server. The command is owner config,
  not the model's choice.
- Process leaks: a `pnpm dev` that outlives the run and keeps holding the port.
- A PR whose body contains broken images.
- A UI verification that eats the run budget and keeps the worker from reaching the PR.

## 3. Owner decisions (2026-11-08)

| Question | Decision |
|---|---|
| Where screenshots go | Into the PR body via the undocumented `uploads.github.com/user-attachments/assets` |
| Who drives the browser | A `ui-tester` subagent of the worker, at the Reviewing stage |
| The "it works" criterion | Passing the UI scenarios derived from `spec.md` |
| Where it runs | Both on the laptop and in the container on the server |
| Subagent model | `sonnet` |

## 4. What we already have

This feature is almost entirely assembled from existing parts.

| What is needed | Where it already lives |
|---|---|
| A channel for third-party MCP servers to the worker | `buildMcpConfig` in `engine/src/infrastructure/claude/run-files.ts` — mixes in `mcpServers` from `~/.jarvis/mcp/servers.json` and substitutes `${VAR}` from secrets; `worker` role only |
| A place for screenshots | `<artifactsDir>/screenshots/` — `artifacts.dirFor(task.id)`, already passed into `workerFirstMessage` |
| A subagent template | `agent/agents/reviewer.md` — `name/description/tools/model` frontmatter, Input → Check → Output contract |
| A place for agent tools | `shared/src/mcp.ts` (`toolInputSchemas`, `toolsByRole`) + `engine/src/presentation/mcp/server.ts` (ADR-0004) |
| Token and GitHub access | `GitHubCodeHost` (`@octokit/rest`) with `createRedactor` on the token |
| A bound on fix rounds | `limits.reviewRounds` + `TRANSITIONS['Reviewing'] → 'Implementing'` with reason `rounds_exhausted` |
| Concurrency | `limits.maxConcurrentWorkers: 1` — one worker, hence one browser |
| A place for limits | `limits` in `shared/src/config.ts`, strict schema, hot reload |
| Playwright as a dependency | `web/` already has `@playwright/test@1.64.1` for our e2e — but that is our repository, not the agent runtime |

What is missing: a browser tool, a managed dev server, a way to put an image into a PR, and
browsers in `docker/runtime/Dockerfile`.

## 5. How it works

### 5.1 When the check runs

The worker runs UI verification in the `Reviewing` stage, **after** `reviewer` and after all of its
blockers are closed, and **before** `git push`. The conditions — all of them together:

1. The `uiCheck:` line of the "Run context" block says `available`. This is the engine's decision, not the model's (see 5.2).
2. `git diff <base>...HEAD --name-only` yields at least one path matching `ui.paths` from the config.
3. `spec.md` contains at least one acceptance criterion that describes visible behavior.

If (1) does not hold, the worker writes the reason into the PR body and `result.md` and moves on
(WRK-10 already requires this; we keep it). If (2) or (3) does not hold, the change is not a UI
change, and the check is skipped without mention.

### 5.2 The `uiCheck` line in Run context

`workerFirstMessage` gets one more line:

```
## Run context
taskId: T-3
branch: jarvis/T-3
artifactsDir: /home/jarvis/.jarvis/tasks/T-3
stage: Reviewing
uiCheck: available
```

Values: `available`, or `disabled: ui.enabled is false`. The engine computes this once per run.
The model never has to guess why the browser is not responding, and it does not try to start one itself.

At first I also wanted a "browser not installed" value, but dropped it: to produce it, the engine
would have to guess where Playwright keeps Chromium, and the check would lie every time it guessed
the wrong path. A missing browser instead shows up as an error on the very first `browser_navigate`,
which the prompt treats as `inconclusive` and surfaces in the PR. More honest than a separate green
flag that cannot be trusted.

### 5.3 The dev server belongs to the engine

The worker does **not** start the server via `Bash`. There are two Jarvis MCP tools for this:

```
start_dev_server: {}                       → { baseUrl: string, expiresAt: string }
stop_dev_server:  {}
```

`start_dev_server` runs `ui.devCommand` in the calling task's worktree, waits until `ui.readyPath`
on `ui.baseUrl` responds with a non-5xx (up to `ui.readyTimeoutSeconds`), and returns the `baseUrl`. Then:

- **The command comes from the config.** The model passes no arguments; `start_dev_server` accepts an
  empty object. This is the defense against the "the agent decides what to run" anti-goal.
- **A lease.** The process lives no longer than `ui.leaseMinutes`. The engine kills the whole process
  tree on timeout, and also when the run finishes, when the task leaves the `Reviewing` stage, and at
  engine startup (picking up orphans after a restart).
- **One slot for the whole engine.** A second `start_dev_server` while someone else's is alive is
  refused with `dev_server_busy`. A single worker slot makes this nearly impossible, but the worker
  slot is config, not an invariant.
- **A repeat call by the same task** extends the lease and returns the same `baseUrl`
  without starting a second process.
- `stop_dev_server` is a polite release; the worker calls it after UI verification. A missed call
  breaks nothing, because the lease exists.

Before starting, the port in `ui.baseUrl` is checked for availability: a port taken by a foreign
process is a `port_busy` refusal, not a silent connection to who knows what.

### 5.4 Playwright MCP

The engine adds one more server to the run's `mcp.json` — alongside `jarvis` and the connectors, only
for the `worker` role, and only when `uiCheck: available`:

```json
{
  "command": "npx",
  "args": [
    "-y", "@playwright/mcp@0.0.84",
    "--headless",
    "--isolated",
    "--browser", "chromium",
    "--viewport-size", "1280x800",
    "--output-dir", "<artifactsDir>/screenshots",
    "--allowed-origins", "http://127.0.0.1:<port>",
    "--console-level", "error",
    "--idle-timeout", "300000",
    "--timeout-action", "5000",
    "--timeout-navigation", "15000",
    "--image-responses", "allow",
    "--no-webmcp",
    "--save-session"
  ]
}
```

Why exactly this:

- `--headless --isolated` — no window and no profile on disk: nothing survives the run.
- `--allowed-origins` with the dev server's single origin — the browser does not go to the external
  internet. Playwright MCP's own documentation says outright that this is *not* a security boundary
  and does not affect redirects, so it is a brake, not a defense; the real boundary is that there is
  nothing valuable in the container.
- `--output-dir` straight into the task's artifacts: a screenshot without an explicit name lands
  where we need it. Note: Playwright MCP resolves files with an explicit name against the workspace
  root, not against `--output-dir` — which is why the `ui-tester` prompt requires taking screenshots
  **without** an explicit name, or with a name relative to `--output-dir`.
- `--idle-timeout 300000` — the browser closes itself after 5 minutes without calls.
- `--console-level error` — the response carries only console errors, not all the noise.
- `--no-webmcp` — the page cannot register its own tools for the agent. For our trust model ("page
  content is data, not instructions", SOUL principle 4) this is mandatory.
- `--save-session` — a transcript of the session stays on disk next to the screenshots; cheap
  diagnostics when a verdict looks odd.
- The `--version` is pinned. `@latest` in the agent runtime means a nondeterministic run.
- In the container, `--no-sandbox` is added (config `ui.noSandbox`), because user namespaces are unavailable there.

**Allowed tools.** The worker's `settings.json` gets in `allow`:

`browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_take_screenshot`,
`browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_hover`,
`browser_select_option`, `browser_drag`, `browser_drop`, `browser_find`, `browser_wait_for`,
`browser_resize`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`,
`browser_handle_dialog`, `browser_tabs`, `browser_close`, `browser_emulate_media`,
`browser_file_upload`.

In `deny` — `browser_evaluate` and `browser_run_code_unsafe`, and only those. Both are arbitrary
code in the page: UI verification does not need it, and the ability to bypass the UI and "prove"
success via `document.querySelector(...).click()` is outright harmful.

`browser_file_upload` was in `deny` until 2026-11-09 because it opens the file system through the
browser. It is allowed now: choosing a file is something a person does in a form, and without it any
scenario with a cover image, an avatar or an import is unreachable — a check of "create an article"
degenerated into recreating the record through the API, which says nothing about the form. The test
is **"did the user interface do it"**, not "is the tool powerful". `ui-tester` is told to upload only
from the artifacts directory or the project under test.

### 5.5 The `ui-tester` subagent

A new file `agent/agents/ui-tester.md`, `model: sonnet`, `tools: Read, Glob, Grep` plus the allowed
`mcp__playwright__browser_*`. **No `Bash`, `Edit`, `Write`** — the tester does not fix code and does
not start processes; it looks and reports. Playwright MCP itself puts the screenshots on disk.

**Input** (the worker passes it as text): `baseUrl`, the path to `spec.md`, a numbered list of UI
scenarios, the scenario cap (`ui.maxScenarios`), the screenshot cap (`ui.maxScreenshots`), and the lease deadline.

**Work:** for each scenario — navigation, actions, `browser_snapshot` to check state,
`browser_take_screenshot` for evidence, `browser_console_messages` and `browser_network_requests`
after the scenario. Scenarios run in order; when the caps or the time run out, the rest are marked
`skipped`, not made up.

**Output** — markdown of exactly this shape:

```
verdict: pass | fail | inconclusive

## Scenarios
1. <name> — pass — criterion: <AC-id from spec.md> — screenshot: screenshots/001-<...>.png
   <one line: what was seen>
2. <name> — fail — criterion: <AC-id> — screenshot: screenshots/002-<...>.png
   <what should have happened, what happened>
3. <name> — skipped — reason: budget | lease expired

## Findings
- blocker — scenario 2 — <what is broken> — <url or locator> — <one-sentence fix>
- suggestion — ...

## Console
- <level> <text>   (or "clean")

## Network
- <method> <url> → <status>   (or "no failures")
```

`verdict: pass` — only when no scenario is `fail` and there are no `blocker`s. `inconclusive` — when
the server did not respond, the lease ran out, or the browser did not start: that is **not** `pass`
and **not** `fail`.

### 5.6 What the worker does with the verdict

- `pass` → on to the PR. Screenshots are attached, the scenarios go into the PR body.
- `fail` → the worker transitions `Reviewing → Implementing`, fixes, and goes through Verifying and
  Reviewing again. This path already exists and is already bounded: each such return spends a round
  from `limits.reviewRounds`, and when they run out, the engine issues `rounds_exhausted`. **No new
  counter is added.** If the rounds are exhausted and a UI blocker remains — it goes into the PR body
  under "Open questions" with a screenshot, not silenced.
- `inconclusive` → the worker does not keep spinning the browser. One retry (a new `start_dev_server`),
  and if it is `inconclusive` again — the PR opens with an explicit line "UI verification failed: <reason>".

### 5.7 Screenshots in the PR

A new Jarvis MCP tool:

```
attach_image: { path: string, alt: string }
  → { ok: true, url: string, markdown: string }
  | { ok: false, reason: string }
```

`path` is relative to `<artifactsDir>`. The engine:

1. Resolves the path and refuses if it escapes the task's artifacts directory (`..`, a symlink,
   an absolute path).
2. Checks the extension (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) and the size (≤ `ui.maxImageMb`,
   default 5 MB).
3. Takes the `repository_id` of the task's target repository (`GET /repos/{owner}/{repo}` → `.id`,
   cached per process).
4. `POST https://uploads.github.com/user-attachments/assets?name=<file>&content_type=<mime>&repository_id=<id>`
   with `Authorization: Bearer <the same token as in CodeHost>`, `Accept: application/json`, raw bytes
   in the body. The response is JSON with a URL of the form `https://github.com/user-attachments/assets/<uuid>`.
5. Returns `markdown: "![<alt>](<url>)"`.

**This endpoint is undocumented.** GitHub has no official API for attachments: the request has been
sitting in community discussions for years, and attachments are officially made only by drag-and-drop
in the browser. The `uploads.github.com/user-attachments/assets` endpoint is the same one the web
interface uses; the author of the article describing it notes that it used to accept only a cookie,
and the token started working recently. Hence three consequences the specification requires:

- All work with it lives in **one adapter** behind a port, with its own tests on a fake `fetch`. When
  the endpoint breaks, one place breaks.
- `{ ok: false, reason }` is a normal response, not an exception. On `401/403/404/410/5xx` the worker
  writes the line `UI screenshots: upload failed (<reason>); files are in <artifactsDir>/screenshots/`
  into the PR body, plus the **list of file names**. A PR with broken images is an anti-goal; a PR
  with an honest line is not.
- The first live check of the endpoint is a separate plan step (11a), on a real PR in the sandbox
  repository. The token in `~/.jarvis/.env` currently returns `Bad credentials` (STATUS.md, item 5),
  and the new token is planned as fine-grained; whether this endpoint accepts a fine-grained PAT has
  not been verified anywhere, and that is the feature's only real risk.

**The PR body.** `pr-body.md` gains a section between "Checks" and "Open questions":

```markdown
## UI verification

`chromium 1280x800`, dev server `http://127.0.0.1:5173`, verdict **pass**

| # | Scenario | Criterion | Result |
|---|----------|----------|-----------|
| 1 | Create a task from chat | AC-3 | pass |
| 2 | Budget banner at 90% | AC-7 | pass |

![Create a task from chat](https://github.com/user-attachments/assets/…)
![Budget banner at 90%](https://github.com/user-attachments/assets/…)
```

### 5.8 Loop protection — the full list

| Bound | Value | Who enforces it |
|---|---|---|
| One browser at a time | `limits.maxConcurrentWorkers: 1` + the dev-server slot | the engine |
| Dev-server lifetime | `ui.leaseMinutes` (default 15) | the engine kills the process tree |
| Browser lifetime without calls | `--idle-timeout 300000` | Playwright MCP |
| Number of scenarios | `ui.maxScenarios` (default 8) | the prompt + the worker trims the list |
| Number of screenshots | `ui.maxScreenshots` (default 12) | `attach_image` refuses past the cap |
| Repeat UI rounds | `limits.reviewRounds` (3) | the state machine, `rounds_exhausted` |
| Retry after `inconclusive` | one | the worker prompt |
| Run turns and budget | `maxTurnsPerRun` 120, `maxBudgetUsdPerRun` $10 | `--max-turns`, `--max-budget-usd` |
| Task lifetime | `taskTimeoutMinutes` 120 | the supervision timer |
| Where the browser may go | `--allowed-origins` = the dev server's origin | Playwright MCP (a brake, not a boundary) |

The key point here: **none of these bounds depends on whether the model obeys.** The prompt-level
bounds (scenarios, retry) are the upper, polite layer; beneath them lie the lease, the slot, the
round counter, and the CLI limits, which cut the tool off regardless of the agent's wishes.

## 6. Config

A new block in `JarvisConfigSchema` (`shared/src/config.ts`), strict, all fields with defaults:

```jsonc
"ui": {
  "enabled": false,                 // the feature is off until the owner turns it on
  "devCommand": "pnpm dev",         // runs in the task's worktree; owner only
  "baseUrl": "http://127.0.0.1:5173",
  "readyPath": "/",
  "readyTimeoutSeconds": 90,
  "leaseMinutes": 15,
  "maxScenarios": 8,
  "maxScreenshots": 12,
  "maxImageMb": 5,
  "attachToPr": true,               // false → the PR carries only the file names
  "noSandbox": false,               // true in the container
  "paths": ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.css", "**/*.scss", "**/*.html"]
}
```

`baseUrl` is constrained by the same rule as `telemetry.otlpEndpoint`: http(s) on `127.0.0.1` or
`localhost`. An agent's dev server reachable from anywhere but loopback is not a feature, it is a hole.

`devCommand` is **not** part of what `update_config` is allowed to patch (ADR-0013 already forbids
patches to `repo.*`, `engine.*`; we add `ui.devCommand`, `ui.noSandbox`, and `ui.paths` to the same
list). The dispatcher has no right to change the command the engine will later execute.

All values go into `jarvis.config.example.json`.

**A known limitation:** `ui.devCommand` is global, while a task may have its own `targetRepo` (ADR-0012). This is
the same limitation as in `allowlist.autoAllowedCommands`, and it is deliberately not closed here. If
the target repository starts with a different command — the owner edits the config.

## 7. Container and server

`docker/runtime/Dockerfile`:

- Before `USER jarvis`, as root: `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` and
  `npx playwright@<pin> install --with-deps chromium`. The directory is readable by `jarvis`.
- `ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` for the runtime.
- `ui.noSandbox: true` in the container's config.

`PLAYWRIGHT_BROWSERS_PATH` is added in `child-env.ts`, because Playwright MCP is the engine's
grandchild (engine → `claude` → MCP server), and without it, it would look for the browser in `$HOME/.cache`.

The image grows by roughly 400 MB. That is the price of the feature working where the system actually
lives. VPS provisioning (`docs/architecture/deployment.md`) gets the same step.

## 8. Acceptance criteria

**Config**

- AC-1. If `ui` is absent from `jarvis.config.json`, then the config is valid, `ui.enabled` is `false`, and
  UI verification does not run.
- AC-2. If `ui.baseUrl` points at a non-loopback host, then config loading fails with a message
  about loopback.
- AC-3. If `update_config` contains a patch to `ui.devCommand`, `ui.noSandbox`, or `ui.paths`, then
  the tool refuses and the config does not change.

**Run context and mcp.json**

- AC-4. If `ui.enabled` is `true` and the browser is installed, then `uiCheck: available` appears in
  the first message of the worker run, and the run's `mcp.json` contains a `playwright` server with
  `--headless`, `--isolated`, `--output-dir <artifactsDir>/screenshots`, and `--allowed-origins` equal
  to the origin of `ui.baseUrl`.
- AC-5. If `ui.enabled` is `false`, then `uiCheck: disabled: ui.enabled is false`, and `mcp.json`
  has no `playwright` server.
- AC-6. For the `dispatcher` role there is no `playwright` server in `mcp.json` under any settings.
- AC-7. The worker run's `settings.json` contains the `browser_*` tools from 5.4 in `allow` —
  `browser_file_upload` among them — and `browser_evaluate` and `browser_run_code_unsafe` in `deny`.
  The `ui-tester` front matter names the same allowed list, since a subagent's `tools` is a closed
  allow-list and a tool missing there is invisible to it however the run's settings read.

**Dev server**

- AC-8. If the worker calls `start_dev_server`, then the engine runs `ui.devCommand` in the worktree
  of exactly the task named by the run token, and returns `baseUrl` only after `readyPath` has
  responded with a non-5xx.
- AC-9. If the server does not come up within `ui.readyTimeoutSeconds`, then the tool refuses with
  `dev_server_not_ready`, and the process is killed.
- AC-10. If a task calls `start_dev_server` while another task's lease is alive, then the refusal is
  `dev_server_busy`, and the existing process is untouched.
- AC-11. If the same worker calls `start_dev_server` again, then no second process
  appears, the lease is extended, and the `baseUrl` is the same.
- AC-12. If the lease expires, then the engine kills the whole process tree and writes an event to the task journal.
- AC-13. If the run finishes (with success, failure, or cancellation) while a lease is alive, then the
  process is killed before the task changes stage.
- AC-14. If the engine starts and finds a recorded lease without a live process, then the record is removed;
  if the process is alive — it is killed.
- AC-15. If the port of `ui.baseUrl` is taken by a third-party process, then `start_dev_server` refuses with
  `port_busy` and starts nothing.

**Attachments**

- AC-16. If `attach_image` receives a path outside `<artifactsDir>` (including via `..` or a
  symlink), then it refuses, and no request goes to GitHub.
- AC-17. If the file is larger than `ui.maxImageMb` or has a disallowed extension, then it refuses before the request.
- AC-18. If GitHub returns a 2xx, then the tool returns `{ ok: true, url, markdown }`, where `markdown`
  is `![alt](url)`.
- AC-19. If GitHub returns 401, 403, 404, 410, or a 5xx, then the tool returns `{ ok: false, reason }`
  without throwing, and `reason` does not contain the token.
- AC-20. If `ui.maxScreenshots` files have already been attached for the task, then the next call refuses with
  `screenshot_limit_reached`.
- AC-21. If `ui.attachToPr` is `false`, then `attach_image` refuses with `attachments_disabled`.

**Verification and PR**

- AC-22. If `uiCheck: available`, the diff touches `ui.paths`, and `spec.md` has a visible criterion, then
  the worker calls `ui-tester` exactly once per Reviewing stage, after the `reviewer` blockers are closed.
- AC-23. If `ui-tester` returns `verdict: fail` with a blocker, then the worker does not push the branch and
  transitions to `Implementing`.
- AC-24. If the `limits.reviewRounds` rounds are exhausted and a UI blocker remains, then the PR opens, and that
  blocker stands in the "Open questions" section of the PR body with a screenshot.
- AC-25. If the `verdict` is `pass`, then the PR body contains a "UI verification" section with the scenario table and
  embedded images, one per scenario with a screenshot.
- AC-26. If an attachment failed, then the PR body contains a line about the failure with the reason and the list
  of file names, and no markdown image link.
- AC-27. If `uiCheck` is `disabled`, then the PR body and `result.md` contain a line with the reason (the WRK-10
  requirement stays in force).
- AC-28. If the `verdict` is `inconclusive` twice in a row, then the worker does not make a third attempt and opens
  the PR with an explicit line about the failed check.

## 9. Edge cases

- **The application requires a login.** `ui-tester` logs in through the application's own form, with
  test credentials the worker found in the project (a seed script, a `*.env.example`, a fixture) and
  passed in the call. They belong to the throwaway database the dev server created and die with it.
  Forbidding this was a mistake: most of an application lives behind its login, and the rule did not
  prevent the login — it moved it to the worker, which drives a browser worse and has `Bash`
  (2026-11-09). What stays forbidden: a credential of the owner's, one invented or reused from
  elsewhere, and typing any credential into a page off `baseUrl`. With no test account in the project
  the scenario is `skipped — no credentials given`, naming the account it needed, and that goes into
  the PR's "Open questions". Persisting a session between runs (`--storage-state`) is still a later
  version.
- **The page writes errors to the console, but the scenario passes.** That is a `suggestion`, not a `blocker`, and it
  goes into the PR's "Console" section. Not every console error is a regression of this diff.
- **A dev server with HMR dies mid-scenario.** `browser_navigate` returns an error → the scenario is `fail` with
  reason `dev server died`, the verdict is `inconclusive`, not `fail`: we do not know whether the change is to blame.
- **A screenshot comes out as 0 bytes.** `attach_image` refuses (size), the scenario keeps its textual
  evidence.
- **The diff touches only a CSS variable in the design tokens.** Rule 5.1 yields `available`, but a distinct
  scenario may be missing from `spec.md`. The worker still calls `ui-tester` — with a single scenario:
  "open page X, check that it renders without console errors, take a screenshot". One
  scenario is still a scenario; there is no such thing as an empty call.
- **Two PRs for the same task.** `attach_image` is not tied to a PR (the GitHub endpoint takes a
  `repository_id`, not a PR number), so the URLs live independently of the PR and survive its recreation.
- **A task with a `targetRepo` different from the default.** The `repository_id` is taken from the task's repository,
  not from the config's `repo`. The dev command is global (see 6).

## 10. Open questions

1. **Does `uploads.github.com/user-attachments/assets` accept a fine-grained PAT?** Unknown. The articles
   describe a token from `gh auth token` (a user OAuth token), while STATUS.md plans a fine-grained PAT
   scoped to a single repository. Verified by plan step 11a; if not — the owner decides between a classic
   PAT and `ui.attachToPr: false`.
2. **Is `--caps vision` needed?** Without it the model works with `browser_snapshot`
   (the textual accessibility tree) and sees an image only in the `browser_take_screenshot` response.
   For "did the layout break" that may not be enough. Decision — after the first live run.
3. **`npx -y` on every run** pulls the package from the registry (or from the cache). In a container with no
   network access to npm this is a failure. The alternative is to pin `@playwright/mcp` as a repository
   dependency and run the local binary. I lean toward the latter, but that is a dependency decision and
   needs a line in ADR-0014.

## 11. Implementation plan

The order is such that each step can be verified on its own.

1. **Config.** The `ui` block in `shared/src/config.ts`, the loopback rule for `baseUrl`, forbidden patches in
   `update_config`, `jarvis.config.example.json`. Tests: `shared/src/config.test.ts`,
   `engine/.../update-config`.
2. **Dev-server port and adapter.** `application/ports/dev-server.ts` (`start`, `stop`, `status`), an
   adapter on `node:child_process` with process-group killing, the lease, and orphan pickup at startup.
   Unit tests on a fake spawn; `port_busy` and `dev_server_not_ready` as separate tests.
3. **The `start_dev_server` / `stop_dev_server` tools.** Schemas in `shared/src/mcp.ts`, `toolsByRole`,
   a route in `presentation/http/routes/agent-tools.ts`, registration in `presentation/mcp/server.ts`.
4. **Attachments port and adapter.** `uploadAttachment` in `CodeHost` + an implementation in `GitHubCodeHost` on
   an injected `fetch`, with the token redactor. Tests on a fake `fetch`: 2xx, 401, 404, 5xx.
5. **The `attach_image` tool.** The schema, path/size/extension checks, a per-task screenshot
   counter, `{ ok: false, reason }` instead of an exception.
6. **Run context and `mcp.json`.** The `uiCheck` line in `workerFirstMessage`; the `playwright` server in
   `buildMcpConfig` with the flags from 5.4; `browser_*` in `allow`/`deny` in `buildWorkerSettings`;
   `PLAYWRIGHT_BROWSERS_PATH` in `child-env.ts`. Tests — the existing `run-files.test.ts` and the
   `run-prompt` tests.
7. **The agent.** `agent/agents/ui-tester.md`; a rewritten WRK-10 section in `agent/prompts/worker.md`
   (when, whom to call, what to do with the verdict, what goes into the PR); the "UI verification" section in the
   `pr-body` template.
8. **The container.** Chromium with `--with-deps` in `docker/runtime/Dockerfile`, `PLAYWRIGHT_BROWSERS_PATH`,
   a step in `docs/architecture/deployment.md`.
9. **ADR.** `0014-ui-verification-with-playwright-mcp.md` — one record for everything: the tool, the subagent,
   the leased dev server, the version pin, and also the screenshots in the PR (the undocumented endpoint, why
   it, the fallback, what to do when it breaks).
10. **e2e.** A scenario in `web/e2e` on a fake `claude`: a task reaches PR Open, and `result.md`
    contains a UI verification section. The browser itself is not started here — this tests the pipeline, not Playwright.
11. **Live check.** On `burnjohn/jarvis-sandbox`: (a) `attach_image` on a real PR with the new
    token — the answer to question 10.1; (b) one UI task end to end, in the container.

Step 11 is the only one that cannot be done from code, and the only one that answers the feature's main risk.

## Sources

- `agent/prompts/worker.md` — WRK-10, the Reviewing and PR stages
- `engine/src/infrastructure/claude/run-files.ts` — `buildMcpConfig`, `buildWorkerSettings`
- `engine/src/application/runs/run-prompt.ts` — the "Run context" block
- `shared/src/config.ts`, `shared/src/mcp.ts` — the config and tool contracts
- `engine/src/domain/task.ts` — `TRANSITIONS`, `reviewRounds`, `rounds_exhausted`
- ADR-0003 (CLI only), ADR-0004 (tools as an engine MCP server), ADR-0005 (limits in config),
  ADR-0009 (agent as a plugin), ADR-0016 (runtime image), ADR-0012 (per-task repo), ADR-0013 (bounds
  of `update_config`)
- `npx @playwright/mcp@0.0.84 --help` and `tools/list`, checked locally on 2026-11-08
- [Programmatically upload attachments to GitHub Issues, Pull Requests, and Comments](https://island94.org/2026/08/programmatically-upload-attachments-to-github-issues-pull-requests-comments)
- [Comment API for uploading images/attachments · community discussion #28219](https://github.com/orgs/community/discussions/28219)
- [Playwright MCP configuration options](https://playwright.dev/mcp/configuration/options)
