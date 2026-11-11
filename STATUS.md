# STATUS

Where Jarvis stands, what is done, what is next. Updated as work lands — see the rules at the bottom.

**Last updated:** 2026-11-11 · **Branch:** `main` ·
**uncommitted:** the ui_check hardening below (config gate, disarmed worker, precomputed diff, ADR-0019 rewrite)

Registers this file deliberately does not duplicate:
[`docs/plans/server-readiness-open-questions.md`](docs/plans/server-readiness-open-questions.md) (findings,
deferred minors, rulings), [`docs/plans/iteration-1.md`](docs/plans/iteration-1.md) (the task plan),
[`docs/architecture/deployment.md`](docs/architecture/deployment.md) (the server runbook).

## Summary

**The pipeline has now carried a real task end to end** (T-3, 2026-11-08): chat → context → spec → plan →
code → checks → review → draft PR [#38 on `burnjohn/quick-blog`](https://github.com/burnjohn/quick-blog/pull/38),
over six worker runs for about $4.09, with no permission card raised. The CI follow-up loop then ran too,
once the watcher was taught which repo to look in (below). Still missing: the server. A Hetzner VPS exists
and is half-provisioned, and the laptop sleeps mid-task, so the always-on run is still ahead.

## Done

- **Roomier chat layout** (T-4, 2026-11-11, branch `jarvis/T-4`): the navigation collapses to an
  icon-only rail from a header button; the thread list column is resizable (drag, arrow keys,
  double-click to reset; 14–32rem); both are kept in the browser's `localStorage`. The composer is one
  frame — a field that grows with the text, the hint on the left and `Send` at the bottom right.
- **Archiving threads and a pinned task model** (2026-11-11): a thread
  can be archived and brought back from its row in the list or the `⋯` menu (`threads.archived_at`,
  migration 0007, `POST /api/threads/:id/archive|unarchive`); archived threads show only under the
  `Archived` filter and archiving touches nothing else — the task and its runs go on. `create_task`
  now stores the model on the task (the named one, else `models.worker` when it is an alias), so the
  header selector shows a real model instead of `Default model`; tasks created earlier show
  `<configured> (default)`, and the selector stays, read-only, once the task is over.
- **Checks judged against main** (on branch feat/checks-judged-against-main, not yet deployed): the engine
  refreshes a task's frozen check list from the remote base's `AGENTS.md` unless its source is `worker`
  (`checks_fixed {source: 'base_refresh'}`); a red command is re-run on the merge base and, red on both, is
  "pre-existing" — it does not block `open_pr`, counts no retry and goes under `## Fails on main too`; the
  worker may pass `open_pr({ skip: [{command, reason}] })` for a command that ran red on the head
  (`skip_not_allowed` otherwise; `## Checks skipped locally — CI decides`). ADR-0022 amended, worker prompt
  updated.
- **Dark redesign of the web UI** (T-3, 2026-11-10/11): a calm dark "liquid glass" theme — frosted
  translucent panels over soft indigo ambient light, indigo accent, self-hosted Inter and JetBrains
  Mono, a Lucide-based `Icon` component, every screen restyled without changing behaviour. The visual
  language is in `docs/specs/web-ui-design.md`.
- **Iteration 1 in full except Phase 5** (the live vertical slice): the task state machine, run scheduler
  with slots and budget, permissions, recovery after restart, Postgres with an append-only journal, the
  Claude CLI runner and its MCP tool server, the GitHub code host and PR watcher, the HTTP API with SSE, and
  the eight-page SPA (chat, overview, tasks, task detail, session console, usage, config, connections).
- **Server readiness, all fifteen tasks**: runtime rehearsal image (ADR-0016), systemd units,
  `scripts/with-secrets.sh` (ADR-0015), telemetry and the Grafana dashboard (ADR-0016), the health route,
  connection probes, the usage query and page.
- **Checks in the working tree** (2026-11-08, after the fixes above): `pnpm typecheck` and `pnpm lint`
  clean; `pnpm test` green — 920 engine, 186 web, 69 shared; `test:int` green — 86. `pnpm format:check`
  flags 5 files that were already unformatted before this work and are left alone deliberately
  (`agent/prompts/dispatcher.md`, `set-task-target-repo.test.ts`, `allowed-repo-resolver.*`,
  `file-profile-store.test.ts`).
- **UI check before the PR (ADR-0014)**, spec `docs/specs/ui-verification.md`: `ui` config
  block (off by default), an engine-leased dev server (`start_dev_server` / `stop_dev_server`, one
  lease engine-wide, killed on lease expiry, run exit, shutdown and on finding an orphan at start),
  Playwright MCP pinned at 0.0.84 in the worker's `mcp.json` with `browser_evaluate`,
  `browser_run_code_unsafe` and `browser_file_upload` denied, the `ui-tester` subagent on sonnet,
  `attach_image` uploading screenshots to GitHub's undocumented `user-attachments` endpoint with a
  plain-text fallback, Chromium in the runtime image, and WRK-10 in `agent/prompts/worker.md`
  rewritten around all of it.
- **Verified live (2026-11-08)**: the rehearsal containers come up healthy; `claude` is logged in inside the
  container (claude.ai, plan Max, CLI 2.1.319) — Gate 1 passed; config hot-reload works; one dispatcher run
  answered in a thread (≈$0.09). That is the only model work this system has ever done.
- **First live task and the four fixes it forced** (2026-11-08, uncommitted):
  - **Permission cards gone.** `agent/settings/worker.json` allows bare `Bash` and leans on a tightened
    deny list instead. Narrow `Bash(cmd:*)` prefixes could not work: Claude Code splits a compound
    command and every part must match, so one `&&` raised a card and the run stalled.
  - **The watcher polled the wrong repository.** `CodeHost.snapshot(prNumber)` carried no repo and
    `GitHubCodeHost` bound one `owner`/`repo` at construction, so ADR-0012's per-task repos never reached
    it: T-3's PR #38 in `quick-blog` was looked up in `jarvis-agent` → endless `Not Found`, task stuck in
    `PR Open`. Worse silently: a same-numbered PR in the default repo would have been judged as the task's.
    `snapshot` / `rerunFailedChecks` now take the repo and the watcher passes `task.targetRepo`.
  - **The PAT no longer lands in `.git/config`** (SEC-04): clone-on-demand baked
    `https://x-access-token:<token>@…` into `remote.origin.url`, in plain text, for the life of the clone.
    The remote is clean now and a credential helper reads the token from the environment; old clones are
    repaired on next use. See ADR-0012.
  - **The chat no longer looks dead.** `PostProgressUpdates` posts a mechanical heartbeat after
    `limits.firstProgressUpdateSeconds` (default 30), then every `limits.progressUpdateMinutes` (default 1),
    with the run's last note and tool for every running run that is not already stalled — the
    worker prompt's soft "post an update" instruction was simply not obeyed.
  - Also: a `RouteError` boundary for stale lazy chunks (a white "Failed to fetch dynamically imported
    module" screen after a redeploy), and artifacts expandable inline in the decision card, because the
    absolute paths the worker printed point inside the container and are dead links for the owner.
- **ui_check hardening (2026-11-09)**, closing the worst of the §8 gap: chat can no longer edit
  `ui.env`, `ui.allowedOrigins` or `ui.autoApproveComments` (`FORBIDDEN_PATHS` now walks nested
  paths and feeds the MCP tool description, one source of truth); a `ui_check` worker runs with
  `Bash`, `Edit` and `NotebookEdit` denied and **no `GH_TOKEN`** (the engine fetches the head,
  precomputes the diff into `.jarvis/changed-files.txt` + `.jarvis/diff.patch` in the worktree,
  and posts the PR comment itself); ADR-0019 rewritten: the environment stays declared per
  repository, but a check of a foreign head executes in a disposable Docker container — the
  earlier draft's host-process-group plan was factually wrong (`spawn({detached:true})` makes a
  new group per child) and is recorded as rejected.
- **Agent memory (ADR-0021, 2026-11-10)**: one self-curating memory under `## Learned` in
  `USER.md` — the dispatcher (`remember`, `forget`, `merge_insights`, `read_memory`) and the
  worker (`note_insight`, `confirm_insight`, `contradict_insight`, `remember_owner`) write it
  without an approval step; every entry carries its timestamp, citations and counts of confirming
  and contradicting tasks; nothing is removed automatically; a `ui_check` task writes nothing; the
  `memory-review` skill tidies on request. Plan: `docs/plans/agent-memory.md`. Verified by tests
  only (incl. `engine/test/flow/memory-flow.int.test.ts`); **not yet tried on a live task**.
- **Engine-side checks and PR (ADR-0022, 2026-11-10)**: `open_pr` replaces `report_checks`,
  `report_pr`, `git push` and `gh pr create`. The engine runs the check commands fixed at spec
  approval, refuses on red, pushes exactly the checked commit from a scratch repository that never
  reads the clone's config, and opens the draft PR; no worker of any kind has a GitHub token; a
  fix round gets the failed CI log as a file. Plan: `docs/plans/engine-side-checks-and-pr.md`.
  Verified by tests only (four whole-flow integration tests, three identical runs); **not yet
  tried on a live task, and the Playwright e2e was updated but still never executed**.
- **A worker no longer needs `AGENTS.md` to find the check commands** (2026-11-09): it looks in
  package scripts, CI workflows and the README, and the owner sees the list with the spec.
- **Checks in the working tree (2026-11-10)**: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
  clean; engine 1255 (unit + integration, with `~/.jarvis/.env` loaded), shared 101, web 186.
  Integration tests fail with `28P01` unless that environment is loaded.
- **Capabilities page (ADR-0025, 2026-11-10)**: lists skills, subagents and MCP servers from every
  source (no secret values); the owner writes his own skills and subagents in `~/.jarvis/plugin`, a second
  plugin every run loads, only through the HTTP API, with backups. Spec `docs/specs/agent-capabilities.md`.
- **Jarvis may target its own repository, behind a flag** (ADR-0012 revised in place, 2026-11-10):
  `repos.allowSelf` (off by default, not writable from chat). The self check used to read
  `repo.path` — the default _target_ — so it blocked the sandbox and left `burnjohn/jarvis-agent`
  open; it now reads the `origin` of the checkout the engine runs from. The engine refuses to start
  when `repo.path` is Jarvis's own repository and the flag is off. Before switching it on: branch
  protection on `main` and CODEOWNERS on the guardrail paths (owner, on GitHub). **Not yet tried on
  a live task.**
- **Limits and models** (2026-11-08): Opus for dispatcher, worker and reviewer; `maxTurnsPerRun 120`,
  `maxBudgetUsdPerRun 10`, `dailyBudgetUsd 50`, `taskTimeoutMinutes 120`, one worker slot, `checkRetries 3`,
  `ciFixRounds 2`, `reviewRounds 3`. On a Max subscription the budget is an estimate, not a bill — a brake
  against runaway loops (ADR-0005).

- **Docs and secrets hardening (2026-11-08)**: ADRs consolidated — secrets into one record (now
  ADR-0015), server operations into one (now ADR-0016), the dispatcher-writable pair and the UI-check
  pair each merged into single records (now ADR-0013, ADR-0014). New ADR-0017: the engine wraps PR
  review comments in `<untrusted-content>` tags (`application/conversation/untrusted.ts`, used by the
  watcher's worker input), and worker/SOUL prompts now require report-and-ask on an injection attempt.
  `compose.yaml` no longer carries a default Postgres password (`${POSTGRES_PASSWORD:?}`; run compose
  with `--env-file ~/.jarvis/.env` or `with-secrets.sh`); the real local password is set in
  `~/.jarvis/.env` and in the running volume. Spec CON-03/04/10 and the architecture README brought up
  to date with ADR-0012/0013/0015/0016.
- **ADR renumbering (2026-11-08)**: superseded records deleted, the remaining 18 renumbered to a
  gapless 0001–0018, every reference across the repo updated; the former numbering lives in git
  history. AGENTS.md now requires specs and all documentation in English; the Ukrainian specs are being
  translated.

## Deployed 2026-11-11 — repository-agnostic UI check (ADR-0026)

- **The engine knows no target project**: the worker composes an environment plan from the target
  repository and `start_dev_server({plan})` runs it in disposable Docker containers (`DockerDevServer`
  replaces `ProcessDevServer`); `ui.devCommand` / `baseUrl` / `readyPath` / `allowedOrigins` / `env` are
  gone from the config; no literal credential in a plan; new skill `agent/skills/project-knowledge`.
- **The UI check is mandatory**: `ui.enabled` defaults to true; `open_pr` answers `ui_check_required`
  for a first PR that touches `ui.paths` without an attempted check; the check also runs in `Fixing`
  and `PR Open`.
- **A failed run says why in the thread** (`RunSink`), instead of leaving "worker started" and silence.
- **On the server**: rootless Docker runs as `jarvis` (linger on, `DOCKER_HOST` in a drop-in of
  `jarvis-engine`), the retired keys and `~/.jarvis/ui/` are removed, commit `1157245` is live.
- Verified: unit tests, typecheck, lint; the adapter against a real Docker daemon on the laptop; on
  the server a rootless container served a loopback port from a read-only mount. **Not verified**: a
  real worker composing a plan for a real repository; the integration tests (no test database
  password on the laptop).
- **After the deploy, same day**: a worker's closing text is posted to the thread (it used to flash in
  the live view and vanish); the daily budget is counted in tokens (`limits.dailyBudgetTokens`, all
  token kinds together) because the CLI's dollar figure is a session total, not a run's — a run now
  records only what it added; three worker slots on the server (2 CPU / 3 GB: watch the memory).
- **Autonomy with daily brakes**: PR comments are posted without a permission card by default
  (`ui.autoApproveComments`), bounded by `limits.maxPrCommentsPerDay` (100); pushes are bounded by
  `limits.maxCommitsPerDay` (100). At a limit nothing is written and the task's thread is told once.
- Left for later: project records (spec section 3), egress filtering of the check network, neutral
  repository names in test fixtures.

## Next

0. **Set the real Postgres password** _(owner)_: generate (`openssl rand -base64 24`), store in Infisical
   (`POSTGRES_PASSWORD`, `DATABASE_URL`, `DATABASE_URL_TEST`) and mirror into `~/.jarvis/.env`; on every
   existing volume (laptop, rehearsal) run
   `docker compose exec postgres psql -U jarvis -c "ALTER USER jarvis PASSWORD '<new>'"`. Until then
   `docker compose up` fails fast asking for the variable (ADR-0015).
1. **Close the four Important findings** of the final review. `Important 3` is fixed on `main`
   (2026-11-10): `ExecStartPost` now runs `scripts/wait-healthy.sh`, which accepts 200 and 503.
2. **Merge `docs/deployment-and-secrets` into `main`** _(owner decision)_. `scripts/deploy.sh` does
   `git merge --ff-only origin/main`, so until this happens the server can only deploy two-week-old code.
3. **Run the e2e suite** (`pnpm --filter @jarvis/web e2e`) — never executed, and the cheapest proof that the
   wiring holds: thread → task → spec approval → PR Open → watcher change → Done, plus the budget banner
   and a permission card, all on the fake CLI. The e2e worker scenario now also calls
   `start_dev_server`, `attach_image` and `stop_dev_server`, so the run proves the UI-check tools are
   reachable and that their refusals (with `ui.enabled: false`) do not derail the task. It needs ports
   4310 and 5180 free: `docker compose stop` first if the rehearsal containers are up.
4. **Verify the GitHub attachment endpoint** (ADR-0014, open question 1 of the UI spec): whether
   `uploads.github.com/user-attachments/assets` accepts a fine-grained PAT is unknown and untested.
   One real PR in the sandbox repo answers it. If it refuses, the choice is a classic PAT or
   `ui.attachToPr: false`.
5. **Prepare a real target repository**: create `burnjohn/jarvis-sandbox`, give it an `AGENTS.md` with check
   commands (since 2026-11-09 the worker finds them in the repository when `AGENTS.md` has none — prompt
   and spec CON-04 changed, not yet tried live), push `main`, point `repo.path` / `TARGET_REPO` at it,
   and list its check commands in `allowlist.autoAllowedCommands` — otherwise every `pnpm test` raises a
   permission card and the run stalls for 30 minutes before being denied.
6. ~~**Replace `GITHUB_TOKEN`**~~ — **done, 2026-11-08.** The token now comes from Infisical, not from
   `~/.jarvis/.env` (whose `GITHUB_TOKEN=` line is empty, which is why the old one read as
   `Bad credentials`: the container was reading nothing at all, not a bad value). Verified from inside the
   rehearsal container through `scripts/with-secrets.sh`: `/user` 200, `repos/burnjohn/quick-blog` 200,
   `pulls/38` 200, and `git push --dry-run` accepted. Still open for the **laptop** path: `pnpm dev` outside
   the container has no Infisical CLI, so it falls back to the empty `~/.jarvis/.env` and has no token.
7. **`jarvis-01` is up** (2026-11-10; Ubuntu 26.04, 2 vCPU, 3.7 GB RAM — below the runbook's 8 GB):
   `jarvis-engine` and `jarvis-web` enabled under systemd, secrets from Infisical `prod` through the
   `jarvis-agent` machine identity (no `~/.jarvis/.env` on the server), `/api/health` ok (database ok,
   claude ok), UI at the tailnet-only `tailscale serve` address, 4310/5180/5433 on loopback only. Left:
   ~~`scripts/deploy.sh` calls `sudo`~~ — deploys now run as root over Tailscale SSH
   (`pnpm run deploy:remote`), the script doing git and pnpm as `jarvis`; rotate the identity's client secret (it passed through a chat); check the
   Hetzner firewall no longer allows port 22; the identity also reads `dev`.
8. **The first live task, on the server** — Phase 5 of the iteration-1 plan. The laptop sleeps mid-task;
   that, more than secrets, is why the first real run belongs on an always-on box.
9. **Run retrospective (spec'd, not planned)**: after a `build` task with 5+ worker runs ends, a
   bounded retro run analyzes the recorded spend (per-run usage, stop reasons, retries, permission
   waits) and proposes improvements only when the projected saving is at least
   `retro.significantSavingsPercent` (default 15) of the task's spend; report-only in iteration
   one, off by default. Owner rulings (2026-11-09): the report is always posted, the threshold only
   classifies proposals as significant/minor, and percentages are computed on tokens. Spec:
   `docs/specs/run-retrospective.md`; execution decided in ADR-0020 (a `retro` run role over an
   engine-precomputed input file, no worker slot, one at a time).
10. **Deliberate limit probes** once the happy path works: `max_turns`, the daily budget, a permission
    timeout, the stall warning, the task timeout, and killing the engine mid-run to exercise
    `ResumeAfterRestart`.
    **Planned, not started:** the workflow registry (ADR-0023, proposed,
    `docs/plans/workflow-registry.md`) and watch sources (ADR-0024, proposed,
    `docs/plans/watch-sources.md`), in that order.
11. **Telemetry for real**: log `stopReason` on `run.finished`, enable `telemetry`, and verify the Claude Code
    metric names against an actual export instead of the documentation.

## Known gaps

Decided, not forgotten.

- **A UI check on someone else's repository still runs their code as the engine's own uid.** The
  environment hand-over is closed (narrowed dev-server env, disarmed tokenless worker, locked
  config paths — see Done, 2026-11-09), but the head's `postinstall` scripts can still read
  `~/.claude`, `~/.jarvis` and the engine's `/proc`, and reach the host's network. The fix is
  ADR-0019's disposable container, not yet implemented. Full detail in
  `docs/specs/ui-check-on-demand.md` §8. **Until then, point checks at repositories you control,
  and use a token scoped to the one repository checked.**
- **No messenger.** The only owner channel is the local web UI (ADR-0006 puts Slack in iteration 2). The
  `OwnerChannel` port exists, so a channel is an adapter, not a rewrite. `tailscale serve` plus a phone is
  the cheap stand-in: it gives access, but no push — nobody tells you a card is waiting.
- **Per-task target repo.** ADR-0012 lets a task carry a `targetRepo` (owner/name), checked against
  `repos.allow` / `repos.allowOwnerRepos` and cloned on demand into `~/.jarvis/repos/<owner>/<name>`.
  `create_task` now takes an optional `repo` and validates + creates the worktree against it from the
  start, so the dispatcher no longer has to redirect an already-created worktree after the fact.
  `set_task_target_repo` still exists but, since a task's worktree is always created at `create_task`
  time, now rejects with a clear error (not a silent no-op) whenever the requested repo differs from
  the one the task already has — a later call can only confirm the existing repo, never move the
  worktree. Per-repo `allowlist.autoAllowedCommands` is still global and owner-maintained (not deferred
  further by this ADR).
- **No scheduling.** Four interval timers (PR watcher, supervision, probe refresh, heartbeat) and a slot
  queue, but nothing time-triggered. Stop-gap: cron calling `POST /api/threads`. Real fix: a `schedules`
  table plus one more `IntervalJob`.
- **No per-subagent cost.** Subagents run inside the worker's process, so their tokens land in the parent
  run's totals and the CLI offers no breakdown. Visible: what a subagent did. Invisible: what it cost.
- **Cost arrives only at a run's exit.** Mid-run there are events, not figures; the brakes are the CLI's own
  `--max-turns` and `--max-budget-usd`.
- **`jarvis` was in the `docker` group on `jarvis-01`** (found 2026-11-10): root-equivalent, so any child
  `claude` with `Bash` could have read the root-only `/etc/jarvis/infisical.env`. The runbook now forbids it
  and drives Docker as root only; removed on the server with the redeploy that follows this change.
- **A child `claude` can read the engine's environment through `/proc`.** Accepted for a single-owner box;
  the real fix is a separate uid for child processes.
- **Never executed anywhere:** Alloy and the Grafana queries, the systemd units, the Google connector, the
  e2e suite. _(The Infisical branch of `with-secrets.sh` left this list on 2026-11-08: the rehearsal
  container runs on it, `dev` and `prod` each hold `GITHUB_TOKEN`, and it is the only secret there — the
  rest of `.env.example` is either empty or local Postgres placeholders that compose hardcodes anyway.)_

## Keeping this file honest

- State verified facts, with the date. "Never run" and "not installed" are findings worth writing down.
- Move items, do not copy them: a finished step leaves **Next** and becomes a line in **Done**.
- Do not duplicate the registers — link to them.
- Keep it readable in two minutes. Anything longer belongs in `docs/`.
