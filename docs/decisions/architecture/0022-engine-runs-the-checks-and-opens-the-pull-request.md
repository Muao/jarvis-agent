---
status: accepted
date: 2026-11-10
decision-makers: ['Ivan Lapa'] # owner: the engine runs the checks, refuses on red, pushes the branch and opens the draft PR; the worker gets no GH_TOKEN (2026-11-10); drafted by Claude
scope:
  [
    'agent/prompts/worker.md',
    'agent/settings/worker.json',
    'shared/src/mcp.ts',
    'shared/src/config.ts',
    'shared/src/api/threads.ts',
    'engine/src/domain/task.ts',
    'engine/src/domain/checks.ts',
    'engine/src/application/tasks/**',
    'engine/src/application/code-host/**',
    'engine/src/application/runs/start-run.ts',
    'engine/src/application/ports/{check-runner,branch-publisher,code-host,artifact-store}.ts',
    'engine/src/infrastructure/checks/**',
    'engine/src/infrastructure/git/**',
    'engine/src/infrastructure/github/**',
    'engine/src/infrastructure/claude/{child-env,claude-cli-runner,run-args}.ts',
    'engine/src/container.ts',
  ]
supersedes: []
superseded-by: []
---

# ADR-0022: The engine runs the checks, refuses on red, pushes the branch and opens the draft PR — the worker has no GitHub token and its check commands are fixed at spec approval

Amends ADR-0004 (the worker's tool list: `report_checks` and `report_pr` leave, `open_pr` arrives) and
ADR-0007 (the bot token is held by the engine only). Generalises the tokenless pattern of ADR-0018.

## Context and Problem Statement

Today a worker, which is a `claude -p` run, does the last third of a task by itself. It runs the
repository's checks and reports `report_checks(passed: boolean)`; it runs `git push` and
`gh pr create` with `GH_TOKEN` in its environment (`child-env.ts`, `buildChildEnv`); it tells the engine
with `report_pr(number, url)`. The engine believes all three. WRK-07 says the worker "fixes and retries,
but no more than `limits.checkRetries`", and nothing makes a red result stop anyone: `ReportChecks`
records what it is told, `ReportPr` moves the task to `PR Open` whatever came before, and a worker that
reports `passed: true` without running anything, or opens the PR after a red report, is caught by no
code. The only barrier is a paragraph of `agent/prompts/worker.md` (stage 5, "never report `passed`
without having run one").

The owner's ruling (2026-11-10) is to move the three steps into the engine, so that two sentences become
true of the system and not only of the prompt:

1. **The agent cannot finish while checks are red.**
2. **The pull request is opened by code, not by the model.**

The same pattern already exists for `ui_check` (ADR-0018, ADR-0019): that worker has no token, the engine
precomputes `.jarvis/diff.patch` and posts the PR comment itself. This record generalises it to the
`build` task.

Three things make the move harder than "call the same commands from the engine":

- **Which commands.** A gate is only as good as its command list. If the model names the commands at
  `open_pr` time, the engine is an obedient shell for whatever the model invented a moment earlier.
- **Fix rounds.** A tokenless worker cannot run `gh run view --log-failed`, so the engine has to hand it
  the failed CI log. The watcher decides to fix inside a database transaction, where a network fetch does
  not belong.
- **What "no token" really buys.** The worker keeps `Bash` and `Read` (`agent/settings/worker.json`), runs
  as the engine's own user and inherits `HOME` (`INHERITED` in `child-env.ts`). Section "What this does
  and does not guarantee" says plainly which claim that supports.

## Decision Drivers

- The two promises above must hold in code: a test must fail if either stops being true.
- A model must not be able to make the engine run a command it chose at PR time.
- The worker keeps running checks itself while it iterates; only the gate moves.
- One pattern for tokenless workers, not a second one beside ADR-0018's.
- The engine must never hand its token to something a worker can steer: not to a hook, a credential
  helper or a rewritten remote in a repository whose config the worker can write.
- The feature-building prompt gets smaller, not larger.

## Considered Options

1. **Harden the status quo**: keep worker-side push and `gh`, tighten the deny list, add a prompt rule.
2. **A pre-push git hook** that runs the checks.
3. **GitHub required status checks only**: let CI be the gate.
4. **One engine tool, `open_pr`**: the engine runs the owner-approved check commands in the worktree,
   and only on green pushes `jarvis/<task-id>` and creates the draft PR; check commands are fixed at
   spec approval.
5. **Two tools, `run_checks` then `open_pr`**, so the worker can ask for the official run early.

## Decision Outcome

**Option 4.**

### The tool

`open_pr({ title?, body? })` replaces `report_checks`, `report_pr`, `git push` and `gh pr create`.

- **First call** (the task has no PR yet): `title` and `body` are required. `title` is one line, at
  most 200 characters; `body` is markdown, at most 20 000 characters, with the sections **What**,
  **Sources** and **Open questions** (WRK-09). The engine adds the **Checks** section itself, from its own
  run (below), so the "checks" claim in a PR is engine-attested.
- **Later calls** (a fix round: the task has a PR): no arguments. The engine runs the gate and pushes the
  new commits to the same branch.
- `base`, `head`, `draft` are never arguments. `head` is `jarvis/<task-id>`, `base` is the configured
  `repo.baseBranch`, `draft` is always true.

The engine, in order:

1. **Stage and lock.** Legal from `Implementing`, `Verifying`, `Reviewing` and `Fixing`; refused elsewhere
   (`wrong_stage`). One gate per task at a time (`already_running`).
2. **Clean tree.** `git status --porcelain` in the worktree must be empty (ignored files excepted), else
   `dirty_tree` with the file list. The gate verifies `HEAD`, and `HEAD` is what gets pushed; a green run
   over uncommitted files would verify something else than it ships. At least one commit beyond the base
   (`no_commits`).
3. **The frozen command list** (below). None frozen → `no_checks_declared`.
4. **Run.** Outside any database transaction. From `Implementing` or `Reviewing` the task moves to
   `Verifying` for the duration, so the owner sees "checks running"; a `Fixing` task stays in `Fixing`
   (`TRANSITIONS` has no `Fixing → Verifying`, and a fix round must not change the watcher's view).
   Commands run in order, each to its own exit; all of them run even when one fails, so one round reports
   every red command (a failing typecheck hides nothing about a failing test).
5. **Red** → `{ ok: false, reason: 'checks_failed', attempt, max, results }`, one `checks_failed`
   journal event, `recordCheckFailure` as today; `Verifying` returns to `Implementing`. When
   `limits.checkRetries` is used up the task moves to `Failed` (`checks_exhausted`) exactly as
   `ReportChecks` does now, and the result says `checks_exhausted`. (See Amendment 2026-11-10: a command
   red on the merge base too is not counted.)
6. **Green** → `checks_passed {headSha, results}`, the failure counter resets (a green gate ends the
   streak the limit exists to bound).
7. **Push** `headSha` to `refs/heads/jarvis/<task-id>`, fast-forward only, by the engine, with the hardened
   invocation below. Rejection → `push_rejected` (the worker rebased or amended; it must not).
8. **Pull request.** No PR yet → `CodeHost.createPullRequest` (draft); the engine appends the Checks
   section and the changed check-defining files to the body. A PR already exists for the head → it is
   returned, not created twice. The task moves to `PR Open`, the watcher gets its record, and the first
   time the owner gets the result card — what `ReportPr` does today, now with the engine as the source.
9. **Returns** `{ ok: true, number, url, headSha, created }`.

A gate that passed for `headSha` is remembered in the journal: if the push or the host call then fails
(`host_error`), the next `open_pr` for the same `headSha` does not run the checks again. Failures that
are not the code's fault — a command that cannot be started (`checks_unavailable`: not found, spawn
error), or a worktree the engine cannot restore after a base run (see Amendment 2026-11-10) — are not
counted against `checkRetries`.

`report_pr` and `report_checks` are removed from the worker's tools; `report_stage` no longer accepts
`Verifying` (the engine sets it). With them gone `open_pr` is the only door to `PR Open` for a `build`
task, which is what makes promise 1 a property of the code rather than of a prompt.

### Where the check commands come from, and how they are fixed

A command list exists for a task from spec approval on, and nothing a model says later can change it.

- **At `submit_spec_for_approval`** the worker may pass `checkCommands: string[]` (at most 8, each one
  line of at most 300 characters). The engine reads the repository's `AGENTS.md` through
  `RepoInfo.commands()` (CON-04) and decides:
  - `AGENTS.md` names check commands → the list is those commands. The worker's `checkCommands`, if
    present, may only **narrow** it (each entry must be one of `AGENTS.md`'s; an owner who writes "drop
    e2e" in a returned spec gets exactly that). It cannot add one.
  - `AGENTS.md` names none → the list is the worker's, which it found in package scripts, CI workflows
    and the README (the 2026-11-09 behaviour), each with its source file recorded in `context.md`.
  - Neither → the submit is refused (`checks_required`); the worker `ask_owner`s, as the prompt already
    says for "no command found".
- **The owner sees the list before approving.** The decision card's body gains `checks: string[]` and
  `checksSource: 'agents_md' | 'worker'`; the engine also appends a plain "Checks the engine will run"
  block to the card's summary, so the owner sees it with no change to the web app.
- **Approval freezes it.** `AnswerDecision` on `approve` writes the journal event
  `checks_fixed {commands, source, cardId}` copied from the card's body, a row only the engine writes.
  `open_pr` reads the latest `checks_fixed`. A spec returned for changes and resubmitted gets a new
  card, and the next approval freezes the new list.
- **No blocklist of "dangerous" commands.** A string match on `sudo` or `curl | sh` is trivially
  bypassed and, once present, is believed (the lesson of ADR-0019's rejected binary allow-list). The
  controls are the ones that work: the owner reads the exact strings, the environment is stripped, and
  every command has a timeout.
- Commands the repository's own `AGENTS.md` lists run unreviewed by anything but the card; commands the
  worker found are marked as such on it. A change to `AGENTS.md`, `package.json` or a CI workflow made by
  the task after approval does not change the frozen list; the PR body names those files (below).

A task that reaches `open_pr` with no `checks_fixed` (it was approved before this record shipped) falls
back to `AGENTS.md` read at that moment, journalled as `checks_fixed {source: 'agents_md_fallback'}`, or
`no_checks_declared` when there is none. See the migration note in the plan.

### How the engine runs them

- A `CheckRunner` port with a `ShellCheckRunner` adapter: `sh -c <command>` with `cwd` the task's worktree,
  one detached process group per command so a timeout or a cancel kills the whole tree (the lesson of
  `ProcessDevServer`), a timeout of `limits.checkTimeoutMinutes` (default 15) per command, and combined
  output capped (the tail is kept).
- **The environment is the dev server's rule applied to checks**: a short inherited list (`PATH`, `HOME`,
  `LANG`, `TMPDIR`, `SHELL`, `USER`, `TERM`) plus `CI=true`, and no `GITHUB_TOKEN`, no `DATABASE_URL`, no
  `INFISICAL_*`, no `CLAUDE_CONFIG_DIR`. A worker's checks used to see `GH_TOKEN` and the same short
  list; the gate is strictly narrower than what it replaces.
- The full log goes to `<artifactsDir>/checks/<attempt>-<sha7>.log`; the tool result carries, per command,
  its exit code, duration and the last 60 lines (4 000 characters).
- The gate emits a run event every 30 seconds while it runs, so a long `pnpm test` is not read as a
  stalled run (DSP-09) and the progress heartbeat keeps its rhythm.
- Killing the worker run, cancelling the task or shutting the engine down kills the gate's process groups.

### The push, and why it is not `git push`

The engine holds the token (`GITHUB_TOKEN`) and pushes from a repository — the clone, shared by all its
worktrees — whose config, hooks directory and remote the worker can write with an ordinary `git config`
or an edit (the worker's `Bash` is bare, `worker.json`). A plain `git push` from the engine would run
whatever the worker had put in `core.hooksPath`, `credential.helper` or `remote.origin.pushurl`, with the
token in the environment. So `GitBranchPublisher`:

- computes the URL itself from the task's repo (`https://github.com/<owner>/<name>.git`, from the task's
  `targetRepo` or the engine's own default repo), never from `git remote get-url`;
- pushes an explicit refspec `<headSha>:refs/heads/jarvis/<task-id>`, with no `--force`, no `--all`, no
  `--tags`, and `jarvis/<task-id>` derived from the task id by the engine;
- runs with `-c core.hooksPath=/dev/null -c credential.helper= -c core.fsmonitor=false
  -c core.sshCommand=false`, `--no-verify`, and an environment of its own: `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, no inherited secrets;
- passes the credential as a header scoped to `https://github.com/` through `GIT_CONFIG_COUNT/KEY/VALUE`
  (`http.https://github.com/.extraheader`, the form `actions/checkout` uses), so the token is in the
  child's environment and never in argv or in any file, and a `url.<x>.insteadOf` written by the worker
  redirects the push to a host that does not match the scope and therefore receives nothing.

**Amended during implementation (2026-11-10): the push does not run in the clone at all.** Flags
alone leave channels this list did not name: `http.proxy` with `http.sslVerify=false` (the token goes
to a host of the worker's choosing), `core.askPass` (runs on a 401 with the token in the
environment), a per-URL `credential.<url>.helper`, and multi-valued keys such as
`http.curloptResolve` that a single `-c` cannot clear. So `GitBranchPublisher` pushes from a
scratch bare repository created from an empty template and linked to the clone only through
`objects/info/alternates`: the clone's config and hooks are never read. The flags above stay as a
second layer. For the same reason `status` and `headSha` do not fetch (a fetch would execute
config the worker can write); they read existing refs with hooks, `core.fsmonitor`, external diff
and textconv disabled.

### Fix rounds

The watcher decides to fix inside its transaction (`HandleCodeHostChange`); the logs are fetched where a
network call belongs, when the fix run is prepared.

- **`CodeHost.failedCheckLogs(prNumber, headSha, repo)`** returns, for each failed check of the head,
  its name and the tail of its log (GitHub Actions job logs; a check with no log yields its URL and
  conclusion). `StartRun` calls it when it prepares a worker run for a task in `Fixing` whose CI is
  red, and writes `<artifactsDir>/fix/ci-<sha7>.log`, **wrapped by `untrustedContent()`** (ADR-0017):
  a CI log is text a test or a dependency can print.
- **Review comments** stay in the run's first message, wrapped, as `reviewInput` already does.
- The first message names the file. The worker reads it, fixes, commits, calls `open_pr` with no
  arguments. The engine pushes the fix commits; the worker never pushes.
- The flaky-CI rerun is already the engine's (`HandleCodeHostChange`, `rerunFailedChecks`); the prompt's
  "say so in `log_note`" line goes.

### The environment of the worker

- `buildChildEnv` stops setting `GH_TOKEN` for any worker: `ui_check` already has none, so the condition
  `taskKind !== 'ui_check'` disappears and `githubToken` leaves the worker's options entirely.
- It adds `GH_CONFIG_DIR=<an empty directory in the run dir>`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0` for a worker run, so the owner's own `gh` login and
  global git credential helper (`HOME` is inherited) are not picked up by accident.
- `agent/settings/worker.json`: the two `allow` lines for `git push` and the five `gh` lines go; the
  fourteen push-variant and `gh` write lines in `deny` collapse to `Bash(git push:*)` and `Bash(gh:*)`
  (plus `Read(~/.jarvis/.env)`), kept as defence in depth, not as the boundary.

### What this does and does not guarantee

**Guaranteed, by code and tested:** through the sanctioned path — the only one the engine knows — a
`build` task reaches `PR Open` only after the engine ran the owner-approved commands to green on the
exact commit it then pushed, and the PR is created by the engine's call to the host with fields the model
does not choose. The gate cannot be satisfied by a claim.

**Not guaranteed:** that a determined worker cannot find another way to GitHub. It runs as the engine's
own user with a shell and a file reader. Where the token sits in `~/.jarvis/.env` (the ADR-0015 fallback)
it can read the file; on Linux it can read the engine's `/proc/<pid>/environ` (ADR-0019 records the same
for `ui_check`); on the laptop the owner's keychain may hold a `gh` or git credential. The `GH_CONFIG_DIR`
and `GIT_CONFIG_GLOBAL` settings and the deny rules remove the accidental routes, not the deliberate ones.
The boundary that would remove them is a worker that does not share the engine's user or filesystem —
the container direction of ADR-0019 — and this record does not build it. Likewise the gate proves that the
approved commands exit 0 on the worker's tree; a worker that edits `package.json` so that `test` is
`true` passes it, and the control against that is the reviewer, the changed-files line in the PR body and
the owner reading the diff.

### Why not the others

- **(1) Hardening the status quo** leaves the claim in a prompt. A deny list over a bare `Bash` is
  `git -c … push`, `env git push`, `sh -c` away from nothing, which ADR-0017 already records as an audit
  finding.
- **(2) A pre-push hook** runs inside the worker's own `git push`, in a repository the worker can write:
  it can delete the hook, set `core.hooksPath` or push with `--no-verify`.
- **(3) GitHub required checks alone** do not stop red code from being pushed or a PR from being opened,
  and CI minutes are the slow way to learn that a typecheck fails. Required checks stay, as the second
  gate (CI-03…CI-05).
- **(5) A separate `run_checks` tool** adds a tool and a paragraph of prompt to save the worker one red
  `open_pr`, which is what the worker's own `Bash` runs are for. If the red-gate cost shows up in practice
  it can be added without changing anything here.
- **Commands named by the model at PR time**, **an owner-edited command list on the card** (a better
  control, a web change; recorded as a later step) and **per-repository command config in
  `jarvis.config.json`** (the most trustworthy source, and one more thing to keep current for every
  repository; ADR-0019 shows the shape if wanted) were weighed; the frozen-at-approval list gets most of
  the control for none of the upkeep.

### Consequences

- Good: both promises are properties of the code, with tests: no route to `PR Open` but `open_pr`, and
  `open_pr` pushes nothing on red.
- Good: the PR's Checks section is written by the engine from what it ran, with the commit it ran on.
- Good: the worker prompt loses its Verifying stage, the push/`gh` steps, the CI-log instructions and most
  of the Fix rounds section; `worker.json` loses its push allow-list and a dozen deny lines.
- Good: one tokenless-worker pattern (ADR-0018's) instead of two.
- Good: the check environment is narrower than before (no `GH_TOKEN`), and the gate has a timeout and a
  process-group kill where the worker's `Bash` had neither.
- Bad: **it is not a sandbox.** See "What this does and does not guarantee": an adversarial worker with
  `Bash` can still look for a token. This record makes the sanctioned path honest; it does not make the
  other paths impossible.
- Bad: **the engine now executes repository code on the host** during the gate, with the engine's user and
  a stripped environment. The worker did the same before, with the token; the difference is that the engine
  process is the parent, so the isolation work of ADR-0019 (a container per run) is now also the way to
  isolate checks.
- Bad: a gate over an environment the engine does not have fails where the worker's would have passed —
  a suite that needs a database URL the worker had exported in its own shell. The owner sees `checks_failed`
  with the real output and declares the variable the way `ui.env` does; there is no per-repository
  check environment yet (superseded in part by Amendment 2026-11-10: the worker may skip such a command and
  CI decides).
- Bad: the frozen list is only as good as `parseAgentsMd`, a heuristic that also picks up `build`, `format`
  and `e2e` commands; the card shows them and the owner narrows by returning the spec.
- Bad: a long gate holds an MCP request open and a worker slot for up to
  `commands × limits.checkTimeoutMinutes` with the model idle; that is the price of the engine owning the
  run, and it is no more than the worker's own `Bash` waited before.
- Bad: tasks approved before this ships carry no frozen list, and resumed sessions keep the system prompt
  of their first request (PRF-03), so they still believe in `git push`. The plan's migration note covers
  both; it costs a transition period in which `report_checks` and `report_pr` answer with a redirect
  instead of being absent.
- Bad: when the engine's `GITHUB_TOKEN` is missing, a task can no longer open a PR at all (it used to fail
  at the worker's `gh`); `open_pr` answers `host_unconfigured`, and the connection screen already shows it.

## Confirmation

- RULE: a `build` worker's tool list has `open_pr` and has neither `report_checks` nor `report_pr`; no
  worker can move a task to `PR Open` except through `OpenPr`.
  CHECK: `shared/src/mcp.ts` `toolsByRole`; unit test that no use case other than `OpenPr` moves a task to
  `PR Open`; `report-stage` test that `Verifying` and `PR Open` are refused.
- RULE: `open_pr` pushes nothing and creates nothing while any frozen check command exits non-zero, unless it
  is red on the merge base too or the worker skipped it after it ran red on that commit.
  CHECK: use-case test on fakes — a red run leaves the publisher's and the host's call lists empty and the
  task in `Implementing` (or `Fixing`).
- RULE: the gate runs `HEAD` and pushes exactly the sha it ran; a dirty tree is refused.
  CHECK: use-case test (`dirty_tree`); adapter test — the refspec is `<sha>:refs/heads/jarvis/<id>`.
- RULE: the commands the engine runs are those frozen at approval, whatever the worker says later.
  CHECK: use-case tests — `open_pr` has no command argument; a `checkCommands` entry not in `AGENTS.md`'s
  list is rejected at submit when `AGENTS.md` has commands; `checks_fixed` is written only by
  `AnswerDecision` on approve and copies the card's list.
- RULE: the decision card shows the list the approval freezes.
  CHECK: use-case test — the card body's `checks` equals the next `checks_fixed.commands`.
- RULE: no worker child process receives `GH_TOKEN` or `GITHUB_TOKEN`, for any task kind.
  CHECK: `child-env` test over both kinds; `run-args`/runner test that the options carry no token.
- RULE: the check child's environment holds no engine credential.
  CHECK: `buildCheckEnv` test in the style of `dev-server-env.test.ts`.
- RULE: a timeout and a cancel kill the command's whole process group.
  CHECK: integration test with a child that spawns a grandchild.
- RULE: the engine's push is unaffected by repository config the worker can write.
  CHECK: integration test on a temp repo whose config sets `core.hooksPath` (a hook that writes a marker),
  `credential.helper` (a helper that writes the environment) and a `url.insteadOf` — after the push, no
  marker exists, the token is in no written file, and the push reached the intended bare remote.
- RULE: the token is in no argv, log line or journal row.
  CHECK: adapter test on the recorded argv; redactor test on a failed push.
- RULE: the first message of a `Fixing` run for red CI names a log file under `fix/` whose content is
  wrapped as untrusted content.
  CHECK: `StartRun` test with a fake host.
- RULE: `checkRetries` counts red gates, resets on a green one, and exhausting it fails the task.
  CHECK: domain test; use-case test through `Failed` with `checks_exhausted`.
- RULE: the worker prompt names none of `git push`, `gh pr create`, `report_checks`, `report_pr`,
  `gh run view`.
  CHECK: a test over `agent/prompts/worker.md`, in the style of the existing prompt/tool-name tests.
- RULE: a fake-`claude` flow reaches `PR Open` through `open_pr` against a local bare remote, and a flow
  whose command exits 1 does not.
  CHECK: `engine/test/flow/` scenarios.

## Amendment 2026-11-10: judged against main

Three rules change how a red check is judged; the gate itself (the engine runs the frozen commands on
`HEAD` and pushes the sha it ran) does not change.

1. **The frozen list follows the base.** Before a run the engine reads `AGENTS.md` from the remote base
   branch and refreshes the task's frozen check list from it, unless the list's source is `worker`. A
   refresh is journalled as `checks_fixed {source: 'base_refresh'}`.
2. **Red on both is not the task's.** A red command is re-run on the merge base. If it is red there too it
   is "pre-existing": it does not block `open_pr`, counts no retry, is listed in `checks_failed` results as
   `preexisting: string[]`, and the PR body carries a `## Fails on main too` section. If the engine cannot
   restore the worktree after the base run, the result is `checks_unavailable`, not counted against retries.
3. **The worker may skip what the environment breaks.** `open_pr({ skip: [{ command, reason }] })` skips a
   frozen command that ran red on the current head; anything else is refused with `skip_not_allowed`. The PR
   body carries a `## Checks skipped locally — CI decides` section.

Confirmation:

- RULE: a task's frozen check list is refreshed from the remote base branch's `AGENTS.md` unless its source
  is `worker`, and the refresh is journalled as `checks_fixed {source: 'base_refresh'}`.
  CHECK: use-case test on fakes — a changed base `AGENTS.md` replaces the list; a `worker` source keeps it.
- RULE: a command red on the merge base as well as on `HEAD` does not block `open_pr`, counts no retry and
  appears under `preexisting` and in the PR body's `## Fails on main too`.
  CHECK: use-case test on fakes — red on both opens the PR with the section; red only on `HEAD` blocks.
- RULE: a skip is accepted only for a frozen command that ran red on the current head, else `skip_not_allowed`;
  skipped commands appear in the PR body's `## Checks skipped locally — CI decides`.
  CHECK: use-case test on fakes — a green or unknown command in `skip` is refused.

## More Information

- Plan: `docs/plans/engine-side-checks-and-pr.md`.
- Verified in the code at the time of writing: `buildChildEnv` sets `GH_TOKEN` for every worker but
  `ui_check`; `ReportChecks` and `ReportPr` trust the model; `TRANSITIONS` has `Verifying → PR Open`,
  `Reviewing → PR Open`, `Fixing → PR Open` and no `Fixing → Verifying`; the clone credential helper reads
  `GH_TOKEN` then `GITHUB_TOKEN`; the worker's `Bash` and `Read` are unrestricted allow rules; `ArtifactStore`
  is read-only and `ArtifactName` a closed enum; the flow and e2e tests build a repo with no remote and the
  container falls back to `unconfiguredCodeHost` without a token; the first-message builder's comment states
  that the CLI keeps a session's system prompt from its first request.
- Inferred, to be confirmed by the first real run: that `git config` from a worktree writes the clone's
  shared config; that the `http.<url>.extraheader` form is accepted for a fine-grained PAT (the
  `actions/checkout` practice says so; STATUS records a `git push --dry-run` accepted with the token, not
  this form); that a long tool call produces no run event and would trip the stall warning without the
  gate's own events; that the default repo's pushes worked through some helper outside this repository's
  code.
- Open questions are in the plan's header and in the report that accompanied this record; the ones that
  change the decision are: whether tasks in flight are drained or migrated, and whether the owner wants the
  command list editable on the card.
- Later, not decided here: a worker that does not share the engine's user (the container direction of
  ADR-0019), after which the "does not guarantee" paragraph can shrink; the commands editable on the card;
  a per-repository check environment next to `ui.repos`; the engine requiring evidence that `reviewer`
  ran before accepting `open_pr`.
