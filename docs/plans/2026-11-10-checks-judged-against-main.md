# Checks judged against main — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A check that cannot pass in Jarvis's check environment never strands a task: the engine
refreshes a frozen list from `main`, tells a pre-existing failure from one the task caused, and lets
the agent skip a red check that CI will judge.

**Architecture:** All of it lives in the `OpenPr` use case (`engine/src/application/tasks/open-pr.ts`)
and the engine's own git (`BranchPublisher` port, `GitBranchPublisher` adapter). Three new journal
events (`check_preexisting`, `check_skipped`, `check_base_result`) and a new `checks_fixed.source`
value (`base_refresh`) carry every decision; the PR body and the thread show them. No owner question
is added anywhere.

**Tech Stack:** TypeScript, Vitest, git CLI via `run-git.ts`, Zod (`shared/src/mcp.ts`).

**Spec:** `docs/specs/generic-engine-and-project-knowledge.md`, section 6 "Checks that can actually
pass". This plan is phase 1 of that spec. Out of scope here and planned separately: the pre-run of
candidate commands on base while in `Context` (it writes into the project record, which does not
exist yet — phase 2), project records, discovered environments and containers (phase 3).

## Global Constraints

- The worker never chooses which commands run: the list still comes only from `checks_fixed` rows
  the engine writes; `base_refresh` reads `AGENTS.md` from the **base branch on the remote**, never
  from the task's worktree or branch.
- A refreshed list is never applied when the frozen one has `source: 'worker'` (the worker found
  those commands; `AGENTS.md` had none).
- Nothing the worker can write (the clone's config, hooks, refs) is read by a network operation:
  `baseFile` fetches in a throwaway bare repository with the engine's config, as `push` does.
- Base checkouts in the worktree run with the `READ_ONLY` git flags (hooks off) and always restore
  `jarvis/<taskId>` in a `finally`.
- No owner question is added. Every decision is a journal event plus, where the owner should know,
  a `system` message in the thread.
- English in code, docs and messages. Conventional commits. Stage explicit paths only (parallel
  sessions share the tree).

## Review Focus

1. **The base checkout fails or is interrupted** (run aborted mid-base-run, `checkout` refused) →
   the worktree must end on `jarvis/<taskId>` with the task's head, and the red result is treated
   as the task's own (no free pass). Test in Task 3.
2. **Every red command is also red on base** → the PR opens, no retry is counted, and the PR body
   says plainly these fail on main too. Test in Task 3.
3. **A skip names a command that never ran red on this head**, or one not in the frozen list →
   refused with a reason, nothing published. Test in Task 4.
4. **The base `AGENTS.md` cannot be fetched** (network, no file, no table) → no refresh, no error;
   the frozen list runs as before. Test in Task 2.
5. **A refreshed list equal to the frozen one** → no new `checks_fixed`, no thread message on every
   call. Test in Task 2.

---

### Task 1: The engine's git reads the base

**Files:**
- Modify: `engine/src/application/ports/branch-publisher.ts`
- Modify: `engine/src/infrastructure/git/git-branch-publisher.ts`
- Modify: `engine/src/application/testing/fakes.ts` (`FakeBranchPublisher`, `FakeCheckRunner`)
- Test: `engine/src/infrastructure/git/git-branch-publisher.int.test.ts` (uses the existing
  `git-branch-publisher.fixture.ts` bare-repo fixture; needs git only, no Docker)

**Interfaces:**
- Produces, on `BranchPublisher`:
  - `baseFile(input: { taskId: string; repo: RepoTarget; path: string }): Promise<string | null>` —
    the file's content at the tip of the remote base branch, fetched now; `null` when the file does
    not exist or the fetch fails (never throws; failures are not the task's problem).
  - `mergeBase(taskId: string): Promise<string>` — `git merge-base HEAD <baseRef>` in the worktree,
    read-only, no network (same `baseRef` rule as `status`).
  - `onBase<T>(taskId: string, sha: string, run: () => Promise<T>): Promise<T>` — detaches the
    worktree at `sha`, runs `run`, and in `finally` checks out `jarvis/<taskId>` again. Throws if
    the tree is dirty before the switch.
- Produces, on the fakes: `FakeBranchPublisher.baseFiles: Map<string, string>` (path → content) and
  `.onBaseCalls: string[]`; `FakeBranchPublisher` takes an optional `FakeCheckRunner` and sets its
  `onBase = true` while `run` executes. `FakeCheckRunner.scriptOnBase(command, outcome)` answers
  while `onBase` is true (default on base: green).

- [ ] **Step 1: Write the failing integration tests** in `git-branch-publisher.int.test.ts`:
  - `baseFile returns AGENTS.md from the remote base tip, not from the task branch` — commit a
    different `AGENTS.md` on `jarvis/T-1` and a newer one on the remote `main`; expect the remote one.
  - `baseFile returns null for a missing file and for an unreachable remote`.
  - `baseFile does not read the clone's config` — set `url.<bare>.insteadOf` to a bogus URL in the
    clone; expect the real content.
  - `onBase runs on the merge base and restores the task branch, even when run throws` — inside
    `run`, `git rev-parse HEAD` equals `mergeBase('T-1')`; after a throwing `run`, HEAD is
    `jarvis/T-1` at its old sha.
  - `onBase does not run a post-checkout hook` — install a hook that writes a marker file; expect no
    marker.
- [ ] **Step 2: Run them, expect FAIL** — `pnpm --filter @jarvis/engine exec vitest run --project int src/infrastructure/git/git-branch-publisher.int.test.ts`
- [ ] **Step 3: Implement** the three methods. `baseFile`: scratch `mkdtemp` + `git init --bare
  --template=` exactly like `push`, then `fetch --depth=1 --no-tags <url> <baseBranch>` with
  `pushEnv(url)` and `HARDENING`, then `show FETCH_HEAD:<path>`; validate `path` with no `..` and no
  leading `/`; redact errors; `rm` the scratch in `finally`. `mergeBase` via `read`. `onBase` via
  `READ_ONLY` `checkout --detach --quiet <sha>` / `checkout --quiet jarvis/<taskId>`; validate `sha`
  with `SHA`.
- [ ] **Step 4: Extend the fakes** as in Interfaces; existing tests stay green.
- [ ] **Step 5: Run** the int file and `pnpm --filter @jarvis/engine test:unit` — PASS; `pnpm --filter @jarvis/engine typecheck` — clean.
- [ ] **Step 6: Commit** `feat(engine): let the engine's git read the base branch and run on it`

### Task 2: A frozen list refreshes itself from main

**Files:**
- Modify: `engine/src/application/tasks/open-pr.ts` (`commandsFor`)
- Modify: `engine/src/application/queries/journal-text.ts` (`checks_fixed` with `base_refresh`)
- Test: `engine/src/application/tasks/open-pr.test.ts` (new `describe('OpenPr — the list follows main')`)

**Interfaces:**
- Consumes: `BranchPublisher.baseFile`, `RepoInfo` parsing — add
  `parseCommands(markdown: string): string[]` to the `RepoInfo` port (implemented in
  `AgentsMdRepoInfo` by `parseAgentsMd(markdown).checkCommands`; `FakeRepoInfo` returns
  `found.checkCommands` unless `parsed` is set).
- Produces: journal `checks_fixed { commands, source: 'base_refresh', cardId: null, previous }`
  with actor `system`; thread `system` message
  `Checks updated from main's AGENTS.md: <old> → <new>.`

- [ ] **Step 1: Write the failing tests:**
  - `refreshes a frozen agents_md list when main's AGENTS.md lists different commands` — freeze
    `['pnpm test']`, `baseFiles.set('AGENTS.md', …)` parsing to `['pnpm test:unit']`; expect the gate
    ran `['pnpm test:unit']`, a `checks_fixed` with `source: 'base_refresh'` and `previous:
    ['pnpm test']`, and one thread message containing `pnpm test:unit`.
  - `leaves a worker-found list alone` — freeze with `source: 'worker'`; gate runs the frozen list,
    no new `checks_fixed`.
  - `does nothing when main's list is the same` — no new row, no message, on two calls.
  - `runs the frozen list when main's AGENTS.md is missing or names no commands`.
  - `treats a frozen row with source null (approved before sources existed) like agents_md`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @jarvis/engine exec vitest run src/application/tasks/open-pr.test.ts`
- [ ] **Step 3: Implement** in `commandsFor`: after `frozenCommands`, if the latest `checks_fixed`
  source is not `'worker'`, `baseFile({taskId, repo, path: 'AGENTS.md'})` → `parseCommands` →
  if non-empty and not equal (order-sensitive) to the frozen list, journal the refresh, post the
  message, return the new list. `journal-text.ts`: `base_refresh` reads
  `Checks updated from main: <list>`.
- [ ] **Step 4: Run** the file — PASS; whole engine unit suite — PASS.
- [ ] **Step 5: Commit** `feat(engine): refresh a task's frozen checks when main's AGENTS.md changes`

### Task 3: A failure main shares is not the task's

**Files:**
- Modify: `engine/src/application/tasks/open-pr.ts` (`gate`, `pullRequestBody`)
- Modify: `engine/src/application/queries/journal-text.ts`
- Test: `engine/src/application/tasks/open-pr.test.ts` (new `describe('OpenPr — red on main too')`)

**Interfaces:**
- Consumes: `BranchPublisher.mergeBase`, `BranchPublisher.onBase`, `CheckRunner.run`.
- Produces: journal `check_base_result { command, baseSha, red: boolean }` (cache, one per command
  and base sha) and `check_preexisting { command, baseSha, headSha }`; `checks_passed` gains
  `preexisting: string[]`; `OpenPrResult` `checks_failed` gains `preexisting: string[]` (red on
  both — told to the worker as not its to fix). PR body section:
  `## Fails on main too` + per command `- ✗ \`<cmd>\` — red on <baseSha7> as well; CI decides.` and
  the last 20 lines of its tail in a `<details>` block.

- [ ] **Step 1: Write the failing tests:**
  - `opens the PR when every red command is also red on main, counting no retry` — script
    `pnpm test` red on head and `scriptOnBase` red; expect `ok: true`, `checkRetries` unchanged,
    one `check_preexisting`, PR body contains `## Fails on main too` and `pnpm test`.
  - `counts a retry when the command is green on main` — red on head, green on base → today's
    `checks_failed` with `preexisting: []`.
  - `mixed: one red on both, one red only on head` → `checks_failed` with
    `preexisting: ['<both>']`, retry counted, nothing published.
  - `runs only the red commands on base, and only once per base sha` — two `open_pr` calls on new
    head shas with the same merge base → `onBaseCalls` has one entry; the second call reads
    `check_base_result`.
  - `a base run that throws or is aborted counts as green on base` — `onBase` rejects → the red is
    the task's (retry counted) and the next `branchPublisher.headSha` is unchanged.
  - `a command that could not be started on base is green on base` (no free pass from exit 127).
  - `on a task that already has a PR, a preexisting failure is told in the thread` — the PR body is
    not rewritten; one `system` message `Fails on main too: pnpm test`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** in `gate`, between phase 2 and phase 3: collect red commands; if any,
  `mergeBase`, look up cached `check_base_result`s in the journal, run the uncached ones in one
  `checkRunner.run` inside `onBase` (log to `checks/<attempt>-<sha7>-base.log`), treat throw / abort /
  `unavailable` as green-on-base. In phase 3: if every red is preexisting → record pass with
  `preexisting`, else today's red path with `preexisting` attached. Thread the `preexisting` results
  through `publish` into `pullRequestBody`.
- [ ] **Step 4: Run** the file and the engine unit suite — PASS.
- [ ] **Step 5: Commit** `feat(engine): judge a red check against main before blaming the task`

### Task 4: The agent may skip a check CI will judge

**Files:**
- Modify: `shared/src/mcp.ts` (`open_pr` schema)
- Modify: `engine/src/application/tasks/open-pr.ts` (`OpenPrInput`, `execute`, `gate`, `pullRequestBody`, refusals)
- Modify: `engine/src/presentation/mcp/server.ts` (`open_pr` description)
- Modify: `engine/src/application/queries/journal-text.ts`
- Test: `shared/src/mcp.test.ts`, `engine/src/application/tasks/open-pr.test.ts` (new `describe('OpenPr — skipping a check')`)

**Interfaces:**
- Produces: `open_pr` input `skip?: { command: string (1..500); reason: string (10..500) }[]` (max 20);
  `OpenPrInput.skip`; refusal reason `'skip_not_allowed'` with `detail` naming the command and why;
  journal `check_skipped { command, reason, headSha }`; PR body section
  `## Checks skipped locally — CI decides` with `- \`<cmd>\` — <reason>` and its last red tail.

- [ ] **Step 1: Write the failing tests:**
  - mcp: `open_pr accepts skip entries and rejects a reason under 10 characters`.
  - `skips a command that ran red on this head and opens the PR` — red `pnpm test` on SHA (one
    `checks_failed` in the journal), then `open_pr({ skip: [{ command: 'pnpm test', reason: 'needs Postgres; CI runs it' }] })`;
    expect the gate ran only the other commands, `ok: true`, a `check_skipped`, PR body section with
    the reason.
  - `refuses to skip a command that never ran red on this head` (new commit since) →
    `skip_not_allowed`, nothing published, no retry.
  - `refuses to skip a command not in the frozen list` → `skip_not_allowed`.
  - `a skip on a task that already has a PR pushes, leaves the PR body alone and tells the thread` —
    from `Fixing` with a PR: `ok: true`, `codeHost.pullRequests` unchanged, one thread `system`
    message `Skipped locally: pnpm test — <reason>`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**: validate before the gate (frozen list membership; a `checks_failed`
  row with this `headSha` whose `results` has the command red); run the gate on the remaining
  commands (all skipped → no gate, treat as green); journal each skip; carry skips to
  `pullRequestBody` / thread message. Description in `server.ts`: one sentence on `skip` and
  `skip_not_allowed`.
- [ ] **Step 4: Run** `pnpm --filter @jarvis/shared test`, the engine file and suite — PASS; both typechecks clean.
- [ ] **Step 5: Commit** `feat(engine): let the worker skip a red check that CI will judge`

### Task 5: Tell the agent and record the decision

**Files:**
- Modify: `agent/prompts/worker.md` (section "6. PR", step 2, and "Fix rounds")
- Modify: `docs/decisions/architecture/0022-engine-runs-the-checks-and-opens-the-pull-request.md`
- Modify: `STATUS.md`
- Test: `engine/src/application/runs/run-prompt.test.ts` only if it snapshots `worker.md` (update the snapshot; no new test)

- [ ] **Step 1: Worker prompt** — add to "6. PR" step 2: a `checks_failed` lists `preexisting`
  commands: those fail on main too and are not yours to fix — do not chase them. If a command keeps
  failing for a reason outside your diff (a service, credentials, ports, the environment) call
  `open_pr` again with `skip: [{command, reason}]`; CI runs it. Never skip a failure your own diff
  caused that you can fix within the retries; never `ask_owner` about the check environment.
- [ ] **Step 2: ADR-0022** — add a section "Amendment 2026-11-10: judged against main" stating the
  three rules (refresh from the remote base's `AGENTS.md` unless `source: worker`; red on both is
  not the task's and does not block; the worker may skip a command that ran red on the current
  head) and their Confirmation RULE lines; adjust the RULE "open_pr pushes nothing … while any
  frozen check command exits non-zero" to "… exits non-zero, unless it is red on the merge base too
  or the worker skipped it after it ran red on that commit".
- [ ] **Step 3: STATUS.md** — one Done bullet with the three behaviours and the commit range.
- [ ] **Step 4: Run** `pnpm typecheck`, `pnpm lint`, `pnpm --filter @jarvis/engine test:unit`,
  `pnpm --filter @jarvis/shared test`, `pnpm --filter @jarvis/web test` — all PASS.
- [ ] **Step 5: Commit** `docs: tell the worker how checks are judged and amend ADR-0022`

### Task 6: Ship

- [ ] **Step 1:** Check no run is live on the server
  (`select count(*) from runs where status='running'` = 0), then `pnpm run deploy:remote`; expect
  `deploy: done, now at <sha>`.
- [ ] **Step 2:** In T-3's thread, the next `open_pr` should journal `checks_fixed (base_refresh)`
  with `test:unit` and open the PR. Report the outcome to the owner.
