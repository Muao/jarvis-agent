# Implementation Plan: the engine runs the checks and opens the pull request (ADR-0022)

**Goal:** a `build` task reaches `PR Open` only through a new worker tool, `open_pr`, with which the
engine runs the owner-approved check commands in the task's worktree, refuses on red, pushes
`jarvis/<task-id>` itself and creates the draft PR through the `CodeHost` port. The worker holds no
GitHub token. Fix rounds hand the worker the failed CI log as a file and push through the same tool.

**Decision:** `docs/decisions/architecture/0022-engine-runs-the-checks-and-opens-the-pull-request.md`
(proposed 2026-11-10). It is binding once accepted; where this plan and the ADR disagree, the ADR wins and
the task reports the disagreement instead of guessing. Amends ADR-0004 and ADR-0007.

**Out of this plan:** moving the worker out of the engine's user or into a container (ADR-0019
direction); an editable command list on the decision card; per-repository check environments; the engine
requiring proof that `reviewer` ran; splitting `ui_check` text out of `worker.md` (listed as Task E3,
optional); any change to `web/` beyond the e2e support file.

**Wait for:** `docs/plans/agent-memory.md` to land. It changes `shared/src/mcp.ts`,
`engine/src/presentation/mcp/server.ts`, `engine/src/presentation/http/routes/agent-tools.ts`,
`engine/src/application/create-application.ts`, `engine/src/application/runs/{run-prompt,start-run}.ts`,
`engine/src/infrastructure/claude/run-args.ts` and `agent/prompts/worker.md`. Every task below edits on top
of the tree as that work leaves it; line numbers quoted from `worker.md` are today's and will have moved.

## Global constraints

- No new dependency in any `package.json` (`@octokit/rest` already has `pulls.create`, `pulls.list` and
  the Actions log endpoints).
- Onion rule (ADR-0002): pure logic in `domain`; ports in `application/ports`; process, git and HTTP only
  in `infrastructure`; use cases reach them through ports.
- Never `ANTHROPIC_API_KEY`, never the Anthropic API (ADR-0003). No test runs the real `claude` (ADR-0011).
- **The token never appears** in argv, a log line, a journal row, an artifact file or a thrown message
  (SEC-04). Errors from the push go through the existing redactor.
- **Do not commit, stage or stash.** Other sessions work in this tree. Edit on top of what is there; do not
  revert or reformat unrelated lines.
- Keep diffs in scope; no drive-by renames.
- Each task ends with its module's tests and typecheck green (commands in `AGENTS.md`) and
  `pnpm exec prettier --check` clean on the files it touched.
- English in code, identifiers, docs and journal text.

## Contracts (fixed here so the tasks agree)

### Tools

| Tool | Role | Input | Returns |
| --- | --- | --- | --- |
| `open_pr` | worker (`build` only) | `{ title?: string, body?: string }` | `OpenPrResult` below |
| `submit_spec_for_approval` | worker | `{ summary, checkCommands?: string[] }` (existing tool, one new field) | `{ cardId }` or the refusal below |
| `report_stage` | worker | `stage` loses `Verifying`: `'Implementing' \| 'Reviewing' \| 'Done'` | `{ ok: true }` |
| `report_checks`, `report_pr` | — | removed from `toolInputSchemas` and `toolsByRole`; for one release the HTTP route answers them with the redirect below | — |

- `title`: one line, 1–200 characters. `body`: 1–20 000 characters. Both **required** when the task has no
  PR, both **ignored** when it has one (not an error).
- `checkCommands`: at most 8 entries, each one line, 1–300 characters, no `\r` or `\n`.

```ts
type OpenPrResult =
  | { ok: true; number: number; url: string; headSha: string; created: boolean }
  | { ok: false; reason: 'wrong_stage' | 'already_running' | 'dirty_tree' | 'no_commits'
        | 'no_checks_declared' | 'checks_unavailable' | 'push_rejected'
        | 'host_unconfigured' | 'host_error' | 'repo_unknown' | 'title_and_body_required'
        ; detail: string; files?: string[] }
  | { ok: false; reason: 'checks_failed'; attempt: number; max: number;
      results: CheckResultDto[]; logPath: string }       // logPath relative to artifactsDir
  | { ok: false; reason: 'checks_exhausted'; max: number; results: CheckResultDto[]; logPath: string };

interface CheckResultDto {
  command: string; exitCode: number | null;               // null: killed or never started
  timedOut: boolean; durationMs: number; tail: string;    // last 60 lines, at most 4 000 characters
}
```

Refusal from `submit_spec_for_approval` when no commands can be fixed:
`{ ok: false, reason: 'checks_required', detail }` (also `checks_not_in_agents_md` when a
`checkCommands` entry is not in a non-empty `AGENTS.md` list, with the offending entries in `detail`).

Redirect for retired tools (migration only): HTTP 200 `{ ok: false, reason: 'tool_retired', use: 'open_pr',
detail: 'Checks, push and the pull request are now done by the engine: commit, then call open_pr.' }`.

### Check-command rules (pure, in `engine/src/domain/checks.ts`)

`resolveCheckCommands({ agentsMd: string[], proposed: string[] | undefined })` returns
`{ ok: true, commands, source: 'agents_md' | 'worker' } | { ok: false, reason }`:

- `agentsMd` non-empty → `proposed` undefined or empty → all of `agentsMd`; otherwise `proposed` must be a
  subset of `agentsMd` (compared after trimming) → `proposed`; else `checks_not_in_agents_md`.
- `agentsMd` empty → `proposed` non-empty → `proposed`, source `worker`; else `checks_required`.
- Duplicates are removed, order is kept.

### Journal events (type → data; `actor` in brackets)

`checks_declared {commands, source}` [agent] — at submit, informational ·
`checks_fixed {commands, source, cardId}` [owner] — on spec approval, **the** list ·
`checks_started {attempt, headSha, commands}` [system] ·
`checks_passed {headSha, results}` [system] · `checks_failed {headSha, results, attempt, max}` [system] ·
`checks_unavailable {headSha, command, detail}` [system] ·
`branch_pushed {headSha, branch}` [system] · `pr_created {number, url}` [system] ·
`pr_opened {number, url, created}` [system] (replaces `pr_reported` for new rows; the old type stays
readable). Existing `checks_passed`/`checks_failed` rows from before keep rendering.

New `TransitionCause`s, all actor `system`: `checks_started` (→ `Verifying`), `checks_red`
(`Verifying` → `Implementing`), `pr_opened` (→ `PR Open`). `pr_reported` stays in the union for old rows.

### Run events

While a gate runs the engine appends one run event every 30 seconds to the worker's run
(`checks running: <command> (<n>s)`), through whatever `RunEventLog` already offers for engine-written
events. Task C1 finds the right call; if none exists it adds the smallest one and says so.

### Config

`limits.checkTimeoutMinutes`: positive int, default 15 — per command. `jarvis.config.example.json` updated.
`limits.checkRetries` keeps its meaning: red gates allowed before `Failed`.

### Files the engine writes for the worker (under `<artifactsDir>`, never in the worktree)

`checks/<attempt>-<sha7>.log` — the whole output of a gate (capped at 5 MB, the tail is kept) ·
`fix/ci-<sha7>.log` — failed CI log(s) of the head, wrapped with `untrustedContent()`.

### Ports (new or extended)

```ts
// application/ports/check-runner.ts
interface CheckRunner {
  run(spec: { cwd: string; commands: readonly string[]; timeoutMs: number;
              signal: AbortSignal; onProgress: (line: string) => void; logPath: string }):
    Promise<{ results: CheckResult[]; unavailable: { command: string; detail: string } | null }>;
}
// application/ports/branch-publisher.ts
interface BranchPublisher {
  headSha(taskId: string): Promise<string>;                           // HEAD of the worktree
  status(taskId: string): Promise<{ dirtyFiles: string[]; commitsAhead: number; changedFiles: string[] }>;
  push(input: { taskId: string; repo: RepoTarget; sha: string }):
    Promise<{ ok: true } | { ok: false; reason: 'rejected' | 'unreachable'; detail: string }>;
}
// application/ports/code-host.ts, added to CodeHost
createPullRequest(input: { head: string; base: string; title: string; body: string }, repo?: RepoTarget):
  Promise<{ ok: true; number: number; url: string; created: boolean } | { ok: false; reason: string }>;
failedCheckLogs(prNumber: number, headSha: string, repo?: RepoTarget):
  Promise<readonly { name: string; conclusion: string; url: string | null; logTail: string | null }[]>;
// application/ports/artifact-store.ts, added to ArtifactStore
writeEngineFile(taskId: string, relativePath: string, content: string): Promise<void>; // rejects '..'
```

`createPullRequest` is always a **draft**, and returns the existing open PR for the head instead of creating
a second (`created: false`).

## Task A — contracts, config, domain (first; B, D and E start in parallel with it)

**Owns:** `shared/src/mcp.ts`, `shared/src/mcp.test.ts`, `shared/src/config.ts`,
`shared/src/config.test.ts`, `shared/src/api/threads.ts` (+ its test), `jarvis.config.example.json`,
`engine/src/domain/task.ts`, `engine/src/domain/task.test.ts`, `engine/src/domain/checks.ts` (new) + test,
`engine/src/domain/index.ts`.

- [ ] A1. `shared/src/mcp.ts`: add `open_pr` (schema as above, strict; `title`/`body` optional at the
      schema level — "required when no PR" is the use case's rule) to `toolInputSchemas` and
      `toolsByRole.worker`; add `checkCommands` to `submit_spec_for_approval`; remove `Verifying` from
      `report_stage.stage`; **keep `report_checks` and `report_pr` in `toolInputSchemas` but remove them
      from `toolsByRole.worker`** (so the MCP server stops advertising them and the settings stop allowing
      them, while the HTTP route can still answer). Tests: role membership; `open_pr` accepts `{}` and
      rejects extra keys, a 201-char title, a multiline title; `checkCommands` bounds.
- [ ] A2. `shared/src/api/threads.ts`: the `decision` message body gains optional
      `checks: string[]` and `checksSource: 'agents_md' | 'worker'` (optional, so existing rows parse).
- [ ] A3. `shared/src/config.ts`: `limits.checkTimeoutMinutes` (default 15); example config and test.
- [ ] A4. `engine/src/domain/checks.ts`: `resolveCheckCommands` (above), `pathsDefiningChecks(files)`
      returning the subset that matches `package.json`, `**/package.json`, `Makefile`, `pyproject.toml`,
      `Cargo.toml`, `.github/workflows/**`, `AGENTS.md`, `tsconfig*.json`, `vitest.config.*`,
      `jest.config.*`, `eslint.config.*` (a plain function with a fixed pattern list, no glob dependency),
      and `recordCheckPass(task)` which sets `counters.checkRetries` to 0. Tests for each rule, including
      the subset check, duplicates and the empty cases.
- [ ] A5. `engine/src/domain/task.ts`: the three new causes with `CAUSE_ACTOR` entries; `pr_reported` stays.
      `TRANSITIONS` is unchanged (verify: `Implementing → Verifying`, `Reviewing → Verifying`,
      `Verifying → Implementing`, `Verifying → PR Open`, `Reviewing → PR Open`, `Fixing → PR Open`
      already exist). Test the new causes' actors.

**Done when:** `pnpm --filter @jarvis/shared test && pnpm --filter @jarvis/shared typecheck` and
`pnpm --filter @jarvis/engine test -- domain && pnpm --filter @jarvis/engine typecheck` pass. The engine
typecheck may be red only where a removed tool is still referenced by Task C's files; list those in the
report instead of editing them.

## Task B — ports and adapters (parallel with A; needs only the contracts)

**Owns:** `engine/src/application/ports/{check-runner,branch-publisher,code-host,artifact-store,index}.ts`,
`engine/src/application/testing/fakes.ts`, `engine/src/infrastructure/checks/**` (new),
`engine/src/infrastructure/git/git-branch-publisher.ts` (+ test, new),
`engine/src/infrastructure/github/github-code-host.ts` (+ test), `engine/src/infrastructure/artifacts/**`.

- [ ] B1. The four port changes above. Fakes: `FakeCheckRunner` (scripted results per command, records the
      calls and the `cwd`), `FakeBranchPublisher` (scripted `status`, records pushes), a `FakeCodeHost`
      extension recording `createPullRequest` and answering `failedCheckLogs`, `writeEngineFile` on the
      in-memory artifact fake. Fakes are what Task C tests with.
- [ ] B2. `infrastructure/checks/build-check-env.ts`: `buildCheckEnv(source)` returns exactly
      `PATH, HOME, LANG, LC_ALL, TERM, TMPDIR, SHELL, USER` when present plus `CI=true`. Copy the shape and the
      test style of `infrastructure/dev-server/dev-server-env.ts` (and its `ENGINE` fixture with every
      secret name). Test: no `GITHUB_TOKEN`, `GH_TOKEN`, `DATABASE_URL`, `INFISICAL_*`, `CLAUDE_CONFIG_DIR`.
- [ ] B3. `infrastructure/checks/shell-check-runner.ts`: `sh -c <command>`, `cwd`, `detached: true`, the
      env above, stdout+stderr both to the log file at `logPath` (append, with a `$ <command>` line before
      each) and to a ring buffer for the tail; per-command timeout kills `-pid` (SIGTERM, then SIGKILL after
      5 s); `signal` abort does the same and stops the loop; `onProgress` fires every 30 s per running
      command; all commands run even after a failure; a command that cannot be spawned, or exits 127, is
      reported through `unavailable` and stops the loop. Read `infrastructure/dev-server/process-dev-server.ts`
      first and reuse its process-group handling instead of inventing one. Tests: unit (exit codes, tail
      length, 127, timeout with a short `timeoutMs`); **integration** (`*.int.test.ts`, like
      `process-dev-server.int.test.ts`): a command that spawns a grandchild is gone after timeout and after
      abort.
- [ ] B4. `infrastructure/git/git-branch-publisher.ts` implementing `BranchPublisher` over `runGit`.
      `headSha`/`status` run in the worktree (`rev-parse HEAD`; `status --porcelain`; `rev-list --count
      <base>..HEAD`; `diff --name-only <base>...HEAD`, base resolved like `GitWorktreeManager.resolveBase`).
      `push` is the **hardened invocation of ADR-0022**: URL built from `repo` (never `remote get-url`),
      refspec `<sha>:refs/heads/jarvis/<taskId>`, no force/all/tags, `--no-verify`,
      `-c core.hooksPath=/dev/null -c credential.helper= -c core.fsmonitor=false -c core.sshCommand=false`,
      an own env (`PATH`, `HOME`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
      `GIT_TERMINAL_PROMPT=0`) and the credential as `GIT_CONFIG_COUNT=1`,
      `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`,
      `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64(x-access-token:TOKEN)>`. `runGit` takes no `env`
      today: add an optional `env` to `RunGitOptions` (this file's task owns that one-line change to
      `run-git.ts`; no other task touches it). Map git's rejection to `rejected`, network errors to
      `unreachable`, and pass every error through the redactor so a token cannot be in `detail`. The
      constructor takes `{ token, worktreesDir, resolver for the worktree path, baseBranch, remote,
      cloneUrl? }` — `cloneUrl`/`remoteUrl` override exists for tests only (a `file://` bare repo; the
      header is then simply unused). Tests: the argv and env recorded through an injectable `runGit`;
      **integration** against a bare repo: pushes the exact sha even when the branch moved on; refuses a
      non-fast-forward; and the **hostile-config fixture** — the temp clone's config sets
      `core.hooksPath` (hook writes a marker file), `credential.helper` (writes `env` to a file) and
      `url.<bare>.insteadOf`; after `push` no marker and no env dump exists and the bare repo received the sha.
- [ ] B5. `GitHubCodeHost.createPullRequest` (`pulls.list` with `head: "<owner>:<branch>"`, `state: open`
      first; else `pulls.create` with `draft: true`) and `failedCheckLogs` (`checks.listForRef`, failed
      Actions jobs → `actions.downloadJobLogsForWorkflowRun`, last 200 lines each, total at most 200 KB;
      a check that is not an Actions job yields `logTail: null`). Errors through the existing `guard`
      (so tokens are redacted); a 422 "already exists" resolves to the existing PR. Tests with the
      injectable `fetch`, as `github-code-host.test.ts` does. `unconfiguredCodeHost` in `container.ts` is
      Task C's; B exports nothing for it.
- [ ] B6. `FileArtifactStore.writeEngineFile`: creates directories, rejects absolute paths and any `..`
      segment, writes atomically (temp file, rename). Test the rejection cases.

**Done when:** `pnpm --filter @jarvis/engine test && pnpm --filter @jarvis/engine test:int &&
pnpm --filter @jarvis/engine typecheck` (the int tests need Docker for Postgres; the B3/B4 integration
tests do not) pass, except for call sites in C's files that still use a removed tool.

## Task C1 — the use cases and the wiring (after A and B; D finishes first)

**Owns:** `engine/src/application/tasks/**` (new `open-pr.ts` + test; changes to `submit-spec.ts`,
`answer-decision.ts`, `report-stage.ts`; **deletes** `report-checks.ts` and `report-pr.ts` with their tests,
moving any assertion still worth having into the new tests), `engine/src/application/queries/journal-text.ts`,
`engine/src/application/testing/{build-test-app,pr-open-flow}.ts`, `engine/src/application/create-application.ts`,
`engine/src/application/index.ts`, `engine/src/container.ts`, `engine/src/presentation/mcp/server.ts`,
`engine/src/presentation/http/routes/agent-tools.ts` (+ `agent.test.ts`),
`engine/src/infrastructure/claude/worker-prompt.test.ts` (new).

- [ ] C1.1 `SubmitSpec`: after the artifact check, read the repo's commands through `RepoInfo.commands()` on
      the task's worktree path, call `resolveCheckCommands`; on refusal return it **without** moving the task;
      on success journal `checks_declared`, put `checks` and `checksSource` into the card body, and append
      "Checks the engine will run before opening the PR:\n- `cmd`…" and the source to the card's `summary`
      (so the owner sees them with no web change). Tests: `AGENTS.md` list used as is; narrowed by the
      worker; a non-member rejected; no `AGENTS.md` + proposal accepted and marked `worker`; neither →
      `checks_required` and the stage unchanged; the card body carries the list.
- [ ] C1.2 `AnswerDecision.answerWithin`: on `approve`, read `checks`/`checksSource` from the card body and
      journal `checks_fixed` in the same transaction as the move. Test: the event equals the card's list;
      `request_changes` writes none.
- [ ] C1.3 `ReportStage`: `Verifying` is no longer a legal worker input (the schema already refuses it;
      the type here follows). Test that `PR Open` and `Verifying` are rejected.
- [ ] C1.4 `OpenPr` (`application/tasks/open-pr.ts`), steps 1–9 of the ADR in that order, with these
      mechanics. The use case does **not** hold a database transaction while the gate or the push runs:
      read in one `transact`, run, then write the outcome in a second `transact` (the `CommentOnPr`
      pattern). An in-memory `Set<taskId>` is the lock (`already_running`). The frozen list is the latest
      `checks_fixed`; absent → fall back to `RepoInfo` on the worktree, journal `checks_fixed` with source
      `agents_md_fallback`, or `no_checks_declared`. Move to `Verifying` (cause `checks_started`) only from
      `Implementing`/`Reviewing`; red from `Verifying` moves back to `Implementing` (`checks_red`). Green
      → `recordCheckPass`; a cached green for the same `headSha` (latest `checks_passed` with that sha and
      no `checks_fixed` after it) skips the run. Red → `recordCheckFailure` (existing domain function);
      exhausted → `Failed` with cause `checks_exhausted`, the same system message and `stopTaskRuns` that
      `ReportChecks` used, result `checks_exhausted`. After the push: `createPullRequest` (first call) with
      the engine-built body — the worker's body, then
      `## Checks (run by Jarvis)` with one line per command (`✓`/`✗`, duration, the head `sha7`) and, when
      `pathsDefiningChecks(changedFiles)` is non-empty, the line "Files that define the checks changed in
      this PR: …"; `attachPullRequest`, move to `PR Open` (cause `pr_opened`), journal `pr_opened`, save
      the watch exactly as `ReportPr` did (`newWatch` unless `watch.prNumber` is unchanged), and post the
      result card on the first PR only. The repo for `push`/`createPullRequest` is `task.targetRepo` or
      `repos.defaultRepo()` (null → `repo_unknown`); the base is `config.repo.baseBranch`; a missing
      token/host → `host_unconfigured`. The gate's `AbortSignal` is aborted when the worker's run ends or
      the task is cancelled — find the hook (`LiveRuns`, `outbox.stopTaskRuns`, or the request's `close`
      event passed down from the route) and use it; if none fits, add the smallest one and say so. Every
      `ok:false` is returned as a value, never thrown. Tests on the fakes, one per `reason` and per rule
      in the ADR's Confirmation section, including: red leaves the publisher and host untouched; the pushed
      sha is the one the runner ran; `Fixing` stays `Fixing` during the run and ends `PR Open`; a second
      call while one runs is refused; abort kills the runner; `checkRetries` reset and exhaustion.
- [ ] C1.5 Progress events during the gate (contract "Run events"); a test that a 70-second fake gate
      produces at least two, using the fake clock.
- [ ] C1.6 `create-application.ts`, `index.ts`: wire `OpenPr` with `uow`, writer, messages, clock, config,
      `repoInfo`, `worktrees`, `checkRunner`, `branchPublisher`, `codeHost`, `artifacts`, `repos`; remove
      `ReportChecks`/`ReportPr`. `container.ts`: construct `ShellCheckRunner` and `GitBranchPublisher` (token
      from `env.githubToken`; absent → a publisher that answers `host_unconfigured`); extend
      `unconfiguredCodeHost` with the two new methods; drop the `githubToken` argument from the
      `ClaudeCliRunner` options (Task D removed the option). Add `ContainerOptions.codeHost?` and
      `ContainerOptions.publisherRemoteUrl?` as test seams (documented as tests-only) so flow and e2e tests can
      use a fake host and a local bare remote.
- [ ] C1.7 `presentation/mcp/server.ts`: `toolDescriptions` for `open_pr` (model-facing: what it does, that
      the engine runs the approved checks, what each refusal means and what to do — `dirty_tree`: commit;
      `checks_failed`: read the tail and `logPath`, fix, call again; `push_rejected`: do not rewrite
      history, merge or rebase onto the remote branch; the call can take minutes) and the changed
      `submit_spec_for_approval`/`report_stage` descriptions. `agent-tools.ts`: route `open_pr`; route the
      retired `report_checks`/`report_pr` to the redirect result. `journal-text.ts`: render the new events.
- [ ] C1.9 A test (put it in `engine/src/infrastructure/claude/worker-prompt.test.ts`, which C1 owns for this
      purpose) that `agent/prompts/worker.md` contains none of `git push`, `gh pr create`, `report_checks`,
      `report_pr`, `gh run view`, and that every Jarvis tool name it mentions is in `toolsByRole.worker`; extend an
      existing prompt test instead if there is one.
- [ ] C1.8 `testing/{build-test-app,pr-open-flow}.ts`: replace the `report_stage Verifying` /
      `reportChecks` / `reportPr` sequences with the new path on fakes; keep every other test green.

**Done when:** `pnpm --filter @jarvis/engine test && pnpm --filter @jarvis/engine test:int &&
pnpm --filter @jarvis/engine typecheck && pnpm lint` pass; `grep -rn "reportChecks\|reportPr\|ReportChecks\|ReportPr"
engine/src` finds only the redirect route and its test.

## Task C2 — fix-round inputs (after A and B; parallel with C1)

**Owns:** `engine/src/application/code-host/**` (`worker-input.ts` + `code-host.test.ts`),
`engine/src/application/runs/start-run.ts` and `run-prompt.ts` (+ tests), `engine/src/application/runs/` tests
for them.

- [ ] C2.1 `ciFailureInput` (worker-input.ts): drop "Read the logs, find the cause, fix it with a new commit
      and push." → "The failed log is at `<path>`. Fix the cause with a new commit and call `open_pr`." The path is
      an argument (`<artifactsDir>/fix/ci-<sha7>.log`); `reviewInput`'s last line ("push a new commit")
      becomes "commit and call `open_pr`". Update `code-host.test.ts`.
- [ ] C2.2 `StartRun.worker`: for a task whose stage is `Fixing` and whose latest `ci_fix_round` journal row
      is newer than the latest `pr_opened` row, call `codeHost.failedCheckLogs(task.pr.number, headSha,
      task.targetRepo)` **outside the transaction** (as `pullRequestContext` does), and write the result with
      `artifacts.writeEngineFile(task.id, 'fix/ci-<sha7>.log', untrustedContent({ source: 'ci-log', ... }))`.
      A host failure is not fatal: the run starts and the first message says the log could not be fetched and
      where the failing checks are (the URLs already in `ciFailureInput`). `headSha` comes from the watch
      record's state; if it is absent, use the failed checks' latest sha from `codeHost.snapshot`.
      Tests: red CI → file written, wrapped, named in the first message; review-only round → no fetch;
      host failure → run still starts.
- [ ] C2.3 `workerFirstMessage`: add one optional field, `notice: string | null`, rendered as a line after
      `uiCheck:` when present, and documented in the `Run context` block of `worker.md` by Task E (E1). `StartRun`
      sets it for a resumed `build` session (`claudeSessionId` not null) whose journal has no `checks_fixed`
      and no `pr_opened`: "Since this release you cannot push or open PRs: commit, then call open_pr; the
      engine runs the checks." Do not reorder existing lines (the memory work added to them). Test both
      directions.

**Done when:** `pnpm --filter @jarvis/engine test && pnpm --filter @jarvis/engine typecheck` pass.

## Task D — the worker's environment and permissions (parallel with A and B; finishes before C1)

**Owns:** `engine/src/infrastructure/claude/{child-env,claude-cli-runner,run-args}.ts` and their tests
(`env.test.ts`, `run-args.test.ts`, `claude-cli-runner.test.ts`), `agent/settings/worker.json`.

- [ ] D1. `buildChildEnv`: no token for any role. Remove the `githubToken` option and the
      `role === 'worker' && taskKind !== 'ui_check'` branch. For `role === 'worker'` set
      `GH_CONFIG_DIR` to `<runDir>/gh` (the caller creates the empty directory), `GIT_CONFIG_GLOBAL=/dev/null`,
      `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`; the function therefore needs the run directory —
      add it as an option. Update `env.test.ts`: both task kinds get no `GH_TOKEN`/`GITHUB_TOKEN`; the
      worker gets the four hardening variables; the dispatcher does not.
- [ ] D2. `claude-cli-runner.ts`: remove `githubToken` from `ClaudeCliRunnerOptions` and the pass-through at
      its call; create `<runDir>/gh` before spawning. `container.ts` still passes the option until C1
      removes it — **D leaves `container.ts` alone and reports the one failing line**; C1 fixes it.
- [ ] D3. `agent/settings/worker.json`: remove from `allow` `Bash(git push origin jarvis/*)`,
      `Bash(git push -u origin jarvis/*)`, `Bash(gh pr create:*)`, `Bash(gh pr view:*)`,
      `Bash(gh pr checks:*)`, `Bash(gh run view:*)`, `Bash(gh run list:*)`; replace the `deny` lines for
      `git push` variants (`--force`, `-f`, `--force-with-lease`, `* --force*`, `* -f`, `* --delete*`,
      `--delete`, `-d`, `origin main`, `origin master`, `origin HEAD:main`, `origin HEAD:master`,
      `origin +*`) and for `gh pr comment|review|edit|merge`, `gh api:*comments*`, `gh issue comment` with
      `Bash(git push:*)` and `Bash(gh:*)`; add `Read(~/.jarvis/.env)`. Keep every other deny line
      (`git branch -D`, `rm -rf`, `git reset --hard`, `git clean`, `git checkout main`, `sudo`, …). A test
      next to `run-args.test.ts` parses the file and asserts these exact sets, so the list cannot drift.

**Done when:** `pnpm --filter @jarvis/engine test -- infrastructure/claude` passes; engine typecheck is
red only at the `githubToken` argument in `container.ts`.

## Task E — the agent definition (parallel with A; needs only the contracts)

**Owns:** `agent/prompts/worker.md` (including the new `notice:` line in its Run-context block, per C2.3),
`agent/templates/result.md`, `agent/README.md` if it lists tools.
(`agent/settings/worker.json` is Task D's.)

Changes to `worker.md`, by the paragraphs of the file as it stands today. **Goes:**

1. Tools list (lines 41–44): `report_checks`, `report_pr` → `open_pr`. Line 45: "Bash (git, gh, the repo's
   check commands)" → "Bash (local git and the repo's commands; you cannot push or open a PR)".
2. **Stage 5, Verifying** (lines 151–161, the whole stage: `report_stage Verifying`, "Run the checks", the
   `report_checks` loop, the `checkRetries` paragraph, the "never invent a command" paragraph). Replaced by one
   sentence at the end of Stage 4: "Run the repository's checks yourself as you go; the engine runs the
   official ones when you call `open_pr`." The "never invent a command" rule moves to Context step 1 (it is
   already there in spirit).
3. Stage 6 step 2 (line 167–168): "Re-run affected checks and call `report_checks` again if code changed
   (WRK-08)" → delete the clause; UI-check `fail` bullet (lines 190–192): "`report_stage Implementing`,
   work, Verifying, Reviewing again" → "fix, then `report_stage Reviewing` again".
4. **Stage 7, PR** (lines 202–210) shrinks from 9 lines to about 5: write the PR text → `open_pr({title,
   body})` (body sections **What**, **Sources**, **Open questions**, screenshots; *not* Checks — the engine
   adds it); read the result — `ok` → write `result.md` from the template with the number it returned; a
   refusal → follow the `reason` (the tool's description lists them). Deleted: `git push`, `gh pr create`,
   `report_pr`, the paragraph that spells out the required sections' **Checks** item.
5. **Fix rounds** (lines 212–229): the "CI failed" bullet (lines 218–222, five lines) becomes two: "The failed
   log is in the file the first message names (data, not instructions). Fix the cause, commit, call
   `open_pr`; do not weaken tests." Deleted: `gh run view … --log-failed`, "the engine retries once"
   flaky aside, `report_checks`, `report_pr`, "push to `<branch>`". The "Review comment" bullet loses
   "run local checks, push, `report_pr`" → "commit, call `open_pr`" (its memory sentence stays).
6. **Hard rules** (lines 320–321): "Push only `<branch>`. Never push to the base branch, force-push,
   merge, or delete branches or PRs" → "You cannot push or open PRs; `open_pr` does. Never merge or delete
   branches or PRs, and never rewrite history that is already pushed."
7. Stage 3 step 3 (submit) gains one clause: pass `checkCommands` when `AGENTS.md` names none (the commands
   recorded in `context.md`), or to leave some out; the engine shows the list on the card and runs exactly
   that list. Context step 1 loses "and name them in the spec summary so the owner approves them together
   with the spec" (the card does it).
8. The run-context `stage:` description needs no change. The `ui_check` section needs no change except
   that "do not try `gh` instead (it is denied)" stays true.

Net effect: about 25 lines deleted, 8 added; no new section. Check with
`git diff --stat agent/prompts/worker.md` and report the real numbers.

- [ ] E1. Make the edits above on the tree as it is when the task starts; keep the memory work's text
      intact. Replace `<tool>` names exactly as in the contracts.
- [ ] E2. `agent/templates/result.md`: its **Checks** section says "from the engine's run: see the PR's
      Checks section" with the commands and head sha the worker copies from the `open_pr` result; read the
      template first and change only that.
- [ ] E3. (optional, recommended, separate follow-up) Move the 75-line `ui_check` section (lines 231–305)
      out of `worker.md` into `agent/prompts/worker-ui-check.md` appended by the engine only for
      `taskKind: ui_check`. Needs a change in `engine/src/infrastructure/claude/run-files.ts` (system prompt
      assembly) — **not part of this plan's ownership**; the owner decides whether it becomes its own task.
**Done when:** `pnpm exec prettier --check agent/` is clean on the touched files and every tool name,
argument and return reason the prompt mentions matches the contracts above.

## Task F — tests of the whole flow (after C1, C2, D, E)

**Owns:** `engine/test/fake-claude/{flow,e2e}.worker.implementing.json` (+ new scenario files),
`engine/test/fake-claude/README.md`, `engine/test/flow/full-flow.int.test.ts`,
`web/e2e/support/start-engine.ts`, `web/e2e/01-happy-path.spec.ts` only if it asserts the old steps.

- [ ] F1. `*.worker.implementing.json`: replace `report_stage Verifying` + `report_checks` + `report_pr`
      with `report_stage Reviewing` then `jarvis_tool open_pr {title, body}`. Add
      `flow.worker.implementing.red.json` (a scenario whose project check command fails: `open_pr` returns
      `checks_failed`, the scripted worker fixes by writing a file, commits through a `tool_use` result and
      calls `open_pr` again). The fake `claude` has no shell; scripts that must commit use a
      `write_files`/`git` step — **extend `fake-claude.mjs` with one step type `git_commit`** (`message`,
      `files`) rather than shelling out, and document it in the README.
- [ ] F2. The flow and e2e repos get a local **bare repo as `origin`** (created next to the temp repo) and
      an `AGENTS.md` whose check command is a real one that exits 0 (`node -e "process.exit(0)"`) — and 1 in
      the red scenario. Use `ContainerOptions.codeHost`/`publisherRemoteUrl` (Task C1.6) with a fake host
      that records `createPullRequest` and returns `{number: 7, url: …}`.
- [ ] F3. `full-flow.int.test.ts`: the approval-resumes-worker test now asserts `PR Open`, PR number 7
      from the fake host, that the bare repo has `jarvis/T-1` at the worktree's `HEAD`, that the journal
      holds `checks_fixed` (before) and `checks_started` → `checks_passed` → `branch_pushed` →
      `pr_opened` (in order); a second test: the red scenario ends `PR Open` only after the second
      `open_pr`, with one `checks_failed` and `counters.checkRetries` 0 afterwards; a third: three reds
      (`limits.checkRetries: 1` in the test config → two) end `Failed` with cause `checks_exhausted`, and
      the bare repo has no `jarvis/T-n` ref. A fourth, on a task in `Fixing` with red CI from a fake host:
      the run's first message names `fix/ci-….log`, the file exists and starts with `<untrusted-content`.
- [ ] F4. `web/e2e/support/start-engine.ts`: the same bare remote and fake host seam; the happy-path spec
      stays green (it reaches `PR Open` as before). Per STATUS the e2e suite has never run: run it once
      (`docker compose stop` first; ports 4310 and 5180) and report the result, passing or not.

**Done when:** `pnpm --filter @jarvis/engine test:int` and `pnpm --filter @jarvis/web e2e` pass, or the
report says exactly which step failed and why.

## Task G — documents (after F; the lead or the owner, not an implementer)

**Owns:** `docs/specs/abstract-project-spec.md`, `docs/decisions/architecture/README.md`, `STATUS.md`,
`docs/architecture/README.md` (+ `overview.html` if it names the old tools),
`docs/decisions/architecture/0004-*.md` (tool list line), `docs/specs/ui-check-on-demand.md` (the mention of
`report_*`), this ADR's status.

- [ ] G1. Spec: WRK-07 ("the engine runs the `Check`… and refuses on red"), WRK-09 ("the engine pushes the
      branch and opens a draft PR from the Jarvis account"), SEC-01 (remove `gh pr create` from the
      pre-approved list), CI-04 (the engine hands the worker the failed log), CON-04 (the commands are
      fixed at spec approval).
- [ ] G2. ADR 0022 `status: accepted`; the row in the ADR index; ADR-0004's worker tool line; STATUS entry
      and the Next list; the architecture README.

## Order

1. **A, B, D, E start together.** They share no file. A defines the contracts the others already have in
   this document.
2. **C1 and C2 start when A, B, D and E report green** (C1 needs `container.ts` free of the `githubToken`
   argument D removed; D hands `container.ts` over to C1, which is the only task that edits it after D).
   C1 and C2 share no file and run in parallel.
3. **F after C1, C2, D and E.** **G after F.**
4. The agent-memory plan lands before any of this starts.

## Migration note: tasks in flight when this deploys

Two facts drive it. A resumed session keeps the system prompt of its first request (PRF-03; the comment
above `workerFirstMessage` in `run-prompt.ts`), so a worker already running believes in `git push`,
`gh pr create`, `report_checks` and `report_pr`. And a task approved before this has no `checks_fixed`.

- **Best:** deploy when no task is between `Spec Review` and `PR Open`. Tasks in `Context` and `Spec Review`
  are safe: their next approval goes through the new `submit_spec_for_approval`; but a `Context` session
  that was approved by the old prompt resumes with the old text, so for these the engine's first message
  also says "Since this release you cannot push; commit and call `open_pr`" (C2.3 adds one such line to the
  run context for any resumed session whose journal has no `checks_fixed`, removed in the release after).
- **`PR Open` tasks (e.g. T-3 on `burnjohn/quick-blog#38`)** continue: a fix round resumes the old session,
  whose first-message instruction is old; the pending message from the engine names `open_pr`; if the
  worker still calls `report_checks`/`report_pr` it gets `tool_retired` with the redirect, and a `git push`
  fails for lack of credentials and its denial. The first `open_pr` of such a task falls back to
  `AGENTS.md` (journal `agents_md_fallback`); a repository with no `AGENTS.md` and no frozen list answers
  `no_checks_declared`, and the owner's choice is to retry the task from `Context` (a new spec card, a new
  frozen list) or cancel it. State this to the owner before deploying.
- **`Implementing`/`Verifying`/`Reviewing` tasks** are handled like the previous case, except they have no
  PR yet: the same fallback, the same redirect. A stage `Verifying` left by an old worker is legal for
  `open_pr` (it is in its allowed stages).
- **Remove the redirect** and the `report_checks`/`report_pr` schemas one release after, when the journal
  shows no `tool_retired` answer for a week.
- No database migration: `Verifying` stays in the stage enum, the new journal event types are rows, and the
  decision body's new fields are optional.

## Review focus

1. Any path to `PR Open` that does not go through `OpenPr`, and any code path in `OpenPr` that pushes or
   creates a PR after a non-zero exit or on a sha other than the one that ran.
2. The token: where it can appear (argv, a log, a thrown message, the journal, the check child's env, the
   worker's env), and the hostile-config test of the push — does it truly fail if `-c core.hooksPath=/dev/null`
   is removed?
3. The command list: can any model input — a tool argument, `context.md`, `AGENTS.md` edited by the task —
   change what `ShellCheckRunner` executes after approval?
4. A killed worker, a cancelled task or an engine shutdown leaving a check's process tree alive.
5. A gate that passed on a dirty or moved tree, and a cached green reused after a new commit.
6. The fix-round log: wrapped as untrusted, size-capped, written outside the worktree.
7. The prompt: no mention of the removed steps, no new section, and the line count down.
