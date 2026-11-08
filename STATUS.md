# STATUS

Where Jarvis stands, what is done, what is next. Updated as work lands — see the rules at the bottom.

**Last updated:** 2026-11-08 · **Branch:** `main`, level with `origin/main` `0364604` ·
**uncommitted:** the whole first-live-task session below (74 modified, 27 new files)

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

- **Iteration 1 in full except Phase 5** (the live vertical slice): the task state machine, run scheduler
  with slots and budget, permissions, recovery after restart, Postgres with an append-only journal, the
  Claude CLI runner and its MCP tool server, the GitHub code host and PR watcher, the HTTP API with SSE, and
  the eight-page SPA (chat, overview, tasks, task detail, session console, usage, config, connections).
- **Server readiness, all fifteen tasks**: runtime rehearsal image (ADR-0017), systemd units,
  `scripts/with-secrets.sh` (ADR-0016), telemetry and the Grafana dashboard (ADR-0018), the health route,
  connection probes, the usage query and page.
- **Checks in the working tree** (2026-11-08, after the fixes above): `pnpm typecheck` and `pnpm lint`
  clean; `pnpm test` green — 920 engine, 186 web, 69 shared; `test:int` green — 86. `pnpm format:check`
  flags 5 files that were already unformatted before this work and are left alone deliberately
  (`agent/prompts/dispatcher.md`, `set-task-target-repo.test.ts`, `allowed-repo-resolver.*`,
  `file-profile-store.test.ts`).
- **UI check before the PR (ADR-0022)**, spec `docs/specs/ui-verification.md`: `ui` config
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
    `GitHubCodeHost` bound one `owner`/`repo` at construction, so ADR-0019's per-task repos never reached
    it: T-3's PR #38 in `quick-blog` was looked up in `jarvis-agent` → endless `Not Found`, task stuck in
    `PR Open`. Worse silently: a same-numbered PR in the default repo would have been judged as the task's.
    `snapshot` / `rerunFailedChecks` now take the repo and the watcher passes `task.targetRepo`.
  - **The PAT no longer lands in `.git/config`** (SEC-04): clone-on-demand baked
    `https://x-access-token:<token>@…` into `remote.origin.url`, in plain text, for the life of the clone.
    The remote is clean now and a credential helper reads the token from the environment; old clones are
    repaired on next use. See ADR-0019.
  - **The chat no longer looks dead.** `PostProgressUpdates` posts a mechanical heartbeat every
    `limits.progressUpdateMinutes` (default 2) for every running run that is not already stalled — the
    worker prompt's soft "post an update" instruction was simply not obeyed.
  - Also: a `RouteError` boundary for stale lazy chunks (a white "Failed to fetch dynamically imported
    module" screen after a redeploy), and artifacts expandable inline in the decision card, because the
    absolute paths the worker printed point inside the container and are dead links for the owner.
- **Limits and models** (2026-11-08): Opus for dispatcher, worker and reviewer; `maxTurnsPerRun 120`,
  `maxBudgetUsdPerRun 10`, `dailyBudgetUsd 50`, `taskTimeoutMinutes 120`, one worker slot, `checkRetries 3`,
  `ciFixRounds 2`, `reviewRounds 3`. On a Max subscription the budget is an estimate, not a bill — a brake
  against runaway loops (ADR-0006).

- **Docs and secrets hardening (2026-11-08)**: ADRs consolidated — new 0024 (secrets only in Infisical)
  and 0025 (server operations) supersede 0007/0015/0016/0017/0018; never-committed 0020+0021 merged into
  0020 (dispatcher-writable owner data) and 0022+0023 into 0022 (UI verification). New ADR-0026: the
  engine wraps PR review comments in `<untrusted-content>` tags (`application/conversation/untrusted.ts`,
  used by the watcher's worker input), and worker/SOUL prompts now require report-and-ask on an
  injection attempt. `compose.yaml` no longer carries a default Postgres password (`${POSTGRES_PASSWORD:?}`;
  run compose with `--env-file ~/.jarvis/.env` or `with-secrets.sh`). Spec CON-03/04/10 and the
  architecture README brought up to date with ADR-0019/0020/0024/0025.

## Next

0. **Set the real Postgres password** *(owner)*: generate (`openssl rand -base64 24`), store in Infisical
   (`POSTGRES_PASSWORD`, `DATABASE_URL`, `DATABASE_URL_TEST`) and mirror into `~/.jarvis/.env`; on every
   existing volume (laptop, rehearsal) run
   `docker compose exec postgres psql -U jarvis -c "ALTER USER jarvis PASSWORD '<new>'"`. Until then
   `docker compose up` fails fast asking for the variable (ADR-0024).
1. **Close the four Important findings** of the final review. `Important 3` — `ExecStartPost`'s `curl -f`
   treating an honest 503 as failure — **must land before the first `systemctl enable`**; it is the only
   item with a deadline.
2. **Merge `docs/deployment-and-secrets` into `main`** _(owner decision)_. `scripts/deploy.sh` does
   `git merge --ff-only origin/main`, so until this happens the server can only deploy two-week-old code.
3. **Run the e2e suite** (`pnpm --filter @jarvis/web e2e`) — never executed, and the cheapest proof that the
   wiring holds: thread → task → spec approval → PR Open → watcher change → Done, plus the budget banner
   and a permission card, all on the fake CLI. The e2e worker scenario now also calls
   `start_dev_server`, `attach_image` and `stop_dev_server`, so the run proves the UI-check tools are
   reachable and that their refusals (with `ui.enabled: false`) do not derail the task. It needs ports
   4310 and 5180 free: `docker compose stop` first if the rehearsal containers are up.
4. **Verify the GitHub attachment endpoint** (ADR-0022, open question 1 of the UI spec): whether
   `uploads.github.com/user-attachments/assets` accepts a fine-grained PAT is unknown and untested.
   One real PR in the sandbox repo answers it. If it refuses, the choice is a classic PAT or
   `ui.attachToPr: false`.
5. **Prepare a real target repository**: create `burnjohn/jarvis-sandbox`, give it an `AGENTS.md` with check
   commands (without them the worker stops and asks), push `main`, point `repo.path` / `TARGET_REPO` at it,
   and list its check commands in `allowlist.autoAllowedCommands` — otherwise every `pnpm test` raises a
   permission card and the run stalls for 30 minutes before being denied.
6. ~~**Replace `GITHUB_TOKEN`**~~ — **done, 2026-11-08.** The token now comes from Infisical, not from
   `~/.jarvis/.env` (whose `GITHUB_TOKEN=` line is empty, which is why the old one read as
   `Bad credentials`: the container was reading nothing at all, not a bad value). Verified from inside the
   rehearsal container through `scripts/with-secrets.sh`: `/user` 200, `repos/burnjohn/quick-blog` 200,
   `pulls/38` 200, and `git push --dry-run` accepted. Still open for the **laptop** path: `pnpm dev` outside
   the container has no Infisical CLI, so it falls back to the empty `~/.jarvis/.env` and has no token.
7. **Finish provisioning `jarvis-01`**: it has the OS, user `jarvis`, Tailscale SSH, Node 22, Docker, git and
   a checkout of `origin/main`. It lacks `claude` _(login is owner-only)_, `gh`, the Infisical CLI
   _(login and project are owner-only)_, Postgres, `~/.jarvis`, the systemd units and `tailscale serve`; and
   `pnpm` on PATH is 12.18.0 against the repo's pinned 10.23.0, so `corepack enable` is needed.
8. **The first live task, on the server** — Phase 5 of the iteration-1 plan. The laptop sleeps mid-task;
   that, more than secrets, is why the first real run belongs on an always-on box.
9. **Deliberate limit probes** once the happy path works: `max_turns`, the daily budget, a permission
   timeout, the stall warning, the task timeout, and killing the engine mid-run to exercise
   `ResumeAfterRestart`.
10. **Telemetry for real**: log `stopReason` on `run.finished`, enable `telemetry`, and verify the Claude Code
    metric names against an actual export instead of the documentation.

## Known gaps

Decided, not forgotten.

- **No messenger.** The only owner channel is the local web UI (ADR-0008 puts Slack in iteration 2). The
  `OwnerChannel` port exists, so a channel is an adapter, not a rewrite. `tailscale serve` plus a phone is
  the cheap stand-in: it gives access, but no push — nobody tells you a card is waiting.
- **Per-task target repo.** ADR-0019 lets a task carry a `targetRepo` (owner/name), checked against
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
