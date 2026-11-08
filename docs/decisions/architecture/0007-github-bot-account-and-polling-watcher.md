---
status: accepted
date: 2026-10-26
decision-makers: []  # owner: Jarvis pushes and opens PRs from its own account with its own token (2026-10-26); drafted by Claude
scope: ["engine/src/infrastructure/github/**", "engine/src/presentation/watcher/**", "engine/src/infrastructure/git/**"]
supersedes: []
superseded-by: []
---

# ADR-0007: Act on GitHub as a separate bot account, and watch CI and reviews by polling the GitHub API

## Context and Problem Statement
Jarvis pushes branches, opens draft PRs, reads CI and reviews, and answers review comments. If it used
the owner's account, the owner could not approve the PR and Jarvis could not tell its own comments from
the owner's (CI-06, CI-08). The laptop has no public address, so GitHub webhooks cannot reach it
(CON-03). The watcher must not call a model while nothing changes (CI-02, NFR-03).

## Considered Options
- Bot account + fine-grained PAT; engine reads GitHub with `@octokit/rest` on a timer; workers use `git` and `gh` with `GH_TOKEN` in their worktree
- Owner's account and token
- GitHub App + webhooks through a tunnel

## Decision Outcome
Chosen option: "Bot account, PAT, polling", because it separates identities with no extra
infrastructure, and polling every `watch.pollSeconds` (ADR-0005) catches up after laptop sleep by
comparing with the last stored state (CI-09).

- Watcher state per PR: head SHA, per-check conclusion, review state, last processed comment id.
- A change (new conclusion, new review, new allowed comment) becomes one domain event; only events that need work start a worker run.
- Comments authored by the bot or by users not in `allowlist.githubReviewers` are ignored.
- Branches are `jarvis/<task-id>`; push to the base branch, force-push and merge are not possible through Jarvis tools and are denied in worker settings.

### Consequences
- Good, because "approved by a human" is a real GitHub state.
- Good, because no tunnel or public URL.
- Bad, because a second GitHub account to create and add as collaborator; participants repeat one more setup step.
- Bad, because polling adds up to `pollSeconds` of delay.

### Confirmation
- RULE: Only `engine/src/infrastructure/github/**` talks to the GitHub API; only `engine/src/infrastructure/git/**` runs `git`.
  CHECK: `grep -rn "@octokit" engine/src | grep -v infrastructure/github`
- RULE: Processing the same GitHub change twice produces no second event (idempotent by check id / review id / comment id).
  CHECK: unit test on the watcher diff
- RULE: Worker settings deny `git push` to the base branch, `--force`, and `gh pr merge`.
  CHECK: unit test on generated worker settings
