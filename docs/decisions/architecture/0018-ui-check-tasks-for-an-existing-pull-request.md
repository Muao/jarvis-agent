---
status: accepted
date: 2026-11-08
decision-makers: [] # owner: the criteria source becomes agnostic (not the browser tool), report in chat and a PR comment only after approve (2026-11-08); drafted by Claude
scope:
  [
    'engine/src/domain/task.ts',
    'engine/drizzle/**',
    'engine/src/application/tasks/create-task.ts',
    'engine/src/application/ui/**',
    'engine/src/application/config/update-config.ts',
    'engine/src/application/ports/{worktree-manager,code-host}.ts',
    'engine/src/infrastructure/git/**',
    'shared/src/{enums,mcp}.ts',
    'agent/prompts/{worker,dispatcher}.md',
    'agent/agents/ui-tester.md',
    'agent/settings/worker.json',
  ]
supersedes: []
superseded-by: []
---

# ADR-0018: Check an existing pull request's UI as a `ui_check` task, with the criteria taken from whatever the PR offers

## Context and Problem Statement

ADR-0014 gave the worker a browser, but only on one path: a task Jarvis itself drove to `Reviewing`,
with the scenarios read from that task's `spec.md`. The owner asked for the other direction — point at
a pull request that already exists, including one Jarvis did not write, and have it checked.

Two things block that today. `start_dev_server` is allowed in `Reviewing` only, and `Reviewing` is
unreachable from `PR Open`/`Fixing` (`TRANSITIONS` in `engine/src/domain/task.ts`), so no message in a
thread can reach the check. Deeper: a foreign PR has no `spec.md`, so even with the stage fixed there
would be nothing to derive scenarios from.

Checking someone else's branch also means **executing their code**: `ui.devCommand` runs the build
config, plugins and lifecycle scripts of that branch on the owner's machine. CI calls this a "pwn
request"; it is the real risk of this feature, not the browser.

## Considered Options

- **Loosen the guard and let a `build` task run the check from `Fixing`.** Smallest diff. Needs a new
  transition out of `Fixing`, works only for PRs that already have a Jarvis task, and gives a
  code-writing task a second life after its PR is open.
- **A separate `ui_check` task kind with its own transition table.**
- **A new `UI Check` stage shared by both kinds.** Rejected in ADR-0014 already, for the same reason:
  a domain change plus a migration plus a prompt, for visibility the journal already gives.
- **No task at all — a one-off "check run" outside the task machinery.** Loses the journal, the
  artifacts directory, the permission cards and the stage reporting, all of which this needs.

## Decision Outcome

Chosen option: **a `ui_check` task kind**, with the criteria source made agnostic. Confirmed by the
owner (2026-11-08): agnostic means the *source of the criteria*, not the browser tool — Playwright MCP
stays the only driver; and the report goes to the chat always, to the PR only after an explicit
approve.

- **`kind` on the task** (`build` | `ui_check`, column default `'build'`), and **transitions depend on
  the kind**. `build` is untouched. `ui_check` goes `Intake → Context → Reviewing → Done` plus the
  exits: no `Spec Review` (nothing to approve), no `Implementing` (it never writes code), no `PR Open`
  (the PR is not ours). The guard on `start_dev_server` therefore does not move, and the check that
  runs before a PR is not affected at all.
- **The criteria come from a cumulative chain:** `spec.md` if the task has one, then the PR body and
  the comments of `allowlist.githubReviewers` authors, then the diff filtered by `ui.paths`. Whatever
  it used is named in the report (`criteria: pr-body + diff`), because a `pass` means nothing without
  knowing what was checked. No scenario at all is `inconclusive`, never `pass`.
- **PR text is untrusted content, and the engine — not the worker — puts it in the prompt**, wrapped
  by `untrustedContent()` per ADR-0017, so an injection attempt stops the run and reaches the owner
  instead of being a judgement call inside it. Text from a PR may only ever *add a scenario*; it can
  never change a limit, a flag, the stage, the verdict or the comment.
- **An untrusted head needs the owner's permission before any of its code runs.** The dev server
  starts unasked only when the PR's head is in the same repository (not a fork) *and* its author is in
  `allowlist.githubReviewers`. Otherwise the engine raises a permission card naming the author, the
  fork and the command that would run; a deny or a timeout ends the task `inconclusive`. There is
  deliberately no setting to switch this off.
- **The PR comment goes through one tool, `comment_on_pr`, gated by the existing permission
  machinery** (`RequestPermission`/`AwaitPermission`), and `gh pr comment` / `gh pr review` are added
  to the worker's `deny`. Without that deny the gate would be decorative: the worker's allow-list
  carries a bare `Bash`, which ADR-0017 already records as an open audit finding.
- **The card is the only limit on how many comments a task writes, and a comment can be replaced.**
  A per-task count of one was tried first and turned out to be a trap: the first run of a check
  commented `inconclusive` because its environment was not set up, which spent the task's only
  comment, and the `pass` verdict the next run reached could never be published (T-4 on
  `burnjohn/quick-blog#38`, 2026-11-08). Counting cannot tell a report from a non-report, and the
  owner already answers a card for every write, so there is nothing for a counter to protect.
  `comment_on_pr` therefore takes an optional `commentId` and rewrites that comment instead of
  adding one — checked against the task's own journal, so an approved card can never be turned into
  an edit of someone else's words.
- **`ui.autoApproveComments` lets the owner switch the card off, and it is off by default.** Being
  asked for every comment is right the first few times and tiresome once the thing works, so the
  owner can stop being asked. It is recorded here rather than left implicit because of what it
  costs: with the counter gone, the card was the only limit on what and how much a run writes on a
  pull request, so turning it on leaves none, and only the journal (`asked: false`) says a comment
  went out unreviewed. The untrusted-head card is a different matter and still has no setting.
- **The worktree for a `ui_check` task stands on the PR head** on a local `jarvis-check/<taskId>`
  branch — a different prefix from `jarvis/*`, so no existing push rule can ever match it.

The "loosen the guard" option was rejected because it only serves PRs Jarvis already owns, which is
the case the owner was not asking about, and because letting a `build` task leave `Fixing` for
`Reviewing` reopens the fix loop the round counters exist to close.

### Consequences

- Good: the owner can point at any allowed repository's PR and get a verdict with screenshots, and
  the feature reuses the repo allowlist, the permission cards, the artifacts and the journal as they
  are.
- Good: `build` tasks cannot reach the new transitions, so the Spec Review gate stays closed for the
  work that writes code.
- Bad: a new column and a per-kind transition table are two more things every stage test has to know
  about; the migration is trivial but the domain is no longer one table.
- Bad: **the check runs code from a branch the owner may not have read.** The permission card makes
  that a decision rather than a surprise, but a careless approve is still an approve. The engine's
  sandboxing is the container (ADR-0016), not this ADR.
- Bad: dependency installation for a foreign branch was left unresolved here — and then settled by
  configuration rather than by decision. The first check that needed data (T-5 on
  `burnjohn/quick-blog#38`, 2026-11-09) put `npm ci` into `ui.devCommand`, so the head's
  `postinstall` scripts now run as a matter of course. That is the follow-up answering itself, and
  it deserves to be seen as such.
- Bad: **the approval card is narrower than it reads.** It decides whether the head may run; it says
  nothing about what the head gets while running. Today that is the engine's whole environment —
  `ProcessDevServer` spawns `ui.devCommand` with `env: { ...options.env }`, which on a configured
  machine carries `GITHUB_TOKEN`, `DATABASE_URL` and `INFISICAL_*`. Sourcing secrets properly
  through Infisical (ADR-0015) does not help at that last hop: provenance and distribution are
  different problems. The head's `CLAUDE.md` is also read as instructions, since the worker's
  working directory is the worktree. Narrowing both is ADR-0019's follow-up, not this record's; what
  belongs here is that the card never promised it.
  `docs/specs/ui-check-on-demand.md` §8 states the whole of it for an operator.

## More Information

- `docs/specs/ui-check-on-demand.md` — the spec and AC-29..AC-52.
- ADR-0014 (the UI check and the screenshots), ADR-0012 (repo allowlist), ADR-0013 (`update_config`
  limits), ADR-0017 (untrusted external content).
