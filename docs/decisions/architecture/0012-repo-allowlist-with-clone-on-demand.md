---
status: accepted
date: 2026-11-08
decision-makers: []  # owner: allow-list or owner-account repos, no fully open cloning (2026-11-08); drafted by Claude
scope: ["shared/src/config.ts", "jarvis.config*.json", "engine/src/infrastructure/config/**", "engine/src/infrastructure/git/**", "engine/src/application/**"]
supersedes: []
superseded-by: []
---

# ADR-0012: Repo allow-list with clone-on-demand, instead of a single fixed `repo.path`

## Context and Problem Statement
CON-04 (`docs/specs/abstract-project-spec.md:41`) fixes Jarvis to one working repository, given as an
already-cloned local path (`repo.path`). Switching target repos today means: clone by hand, edit
`repo.path`, add the repo's check commands to `allowlist.autoAllowedCommands`, restart. The owner wants
Jarvis to be able to clone a repository itself, scoped to either an explicit allow-list or any repository
owned by the owner's own GitHub account — not an open "clone anything" capability.

This changes CON-04 and the "one repository per instance" item in STATUS.md's Known gaps: it widens the
engine from one preconfigured repo to a small, named set of repos it may create worktrees for on demand.

## Considered Options
- **Keep CON-04 as is**: owner clones manually before every repo switch (status quo).
- **Allow-list + clone-on-demand**: config lists permitted repos (explicit `owner/name` entries, or a flag
  meaning "any repo under this GitHub account"); the engine clones a missing one into `~/.jarvis/repos/<owner>/<name>`
  the first time a task targets it, using the existing `GITHUB_TOKEN`.
- **Fully open cloning**: worker/dispatcher clones whatever URL a task mentions, no allow-list.

## Decision Outcome
Chosen option: "Allow-list + clone-on-demand" — it removes the manual clone step the owner asked about,
without reopening CON-04's reason for existing (a task must not be able to point Jarvis at an arbitrary
repository; "fully open cloning" was rejected for that reason). Confirmed by the owner (2026-11-08):
allow-list or repos owned by the owner's own GitHub account, nothing wider.

- `jarvis.config.json` gains `repos: { allow: string[] /* "owner/name" */, allowOwnerRepos: boolean }`.
  `repo.path` / `repo.remote` / `repo.baseBranch` (ADR-0005) stay as the *default* repo (`repos.allow[0]`
  equivalent) so existing single-repo configs keep working unchanged.
- Resolving a task's target repo: reject if the repo is neither in `repos.allow` nor (when
  `allowOwnerRepos` is true) owned by the account `GITHUB_TOKEN` authenticates as. Ownership is checked via
  the GitHub API at resolution time, not cached, so removing a repo from the account takes effect
  immediately.
- Clone destination: `~/.jarvis/repos/<owner>/<name>`, one working tree per repo, created lazily on first
  use with `git clone` over the existing bot `GITHUB_TOKEN` (ADR-0007) — no new credential.
- The token is **never written into `remote.origin.url`** (SEC-04, owner decision 2026-11-08): a baked-in
  URL persists the PAT in plain text in `.git/config` for the life of the clone, where `git remote -v`, a
  pasted bug report or a backup carries it out. The remote stays clean and a `credential.https://github.com.helper`
  entry — which holds no secret — reads the token from the environment (`GH_TOKEN` in a worker's child,
  `GITHUB_TOKEN` in the engine) each time git asks. Clones made before this are repaired on next use.
- The target repo's `AGENTS.md` contract (CON-04's check-commands requirement) still applies per repo;
  Jarvis does not infer check commands from it. A repo without a usable `AGENTS.md` still makes the
  worker stop and ask, per WRK-07.
- Jarvis's own repository must never be clone-able through this path (a task must not be able to target
  Jarvis itself); the engine excludes its own `repo.path` / git remote from allow-list resolution.
- **`autoAllowedCommands` becomes per-repo and dispatcher-writable** (owner decision, 2026-11-08,
  superseding this ADR's original "stays global and owner-maintained" line): `allowlist.autoAllowedCommands`
  gains a `repos` map keyed by `"owner/name"`; the top-level array stays as the default repo's list
  (unchanged for existing single-repo configs). A dispatcher-facing MCP tool (same shape as
  `set_task_target_repo`) lets the owner, from chat, ask Jarvis to add a command to the *current task's
  target repo's* allow-list — e.g. "дозволь `pnpm test` у QuickBlog" — so the owner no longer edits
  `jarvis.config.json` by hand per repo. This is a deliberately accepted widening of the permission-gate
  boundary (see Consequences): the dispatcher can grant run-without-asking rights to itself, scoped to one
  repo's command allow-list, never to `repos.allow`/`allowOwnerRepos` themselves (those stay owner-edited
  config only, no MCP tool writes them).

### Consequences
- Good, because switching or adding a target repo no longer needs a restart or a manual `git clone` step.
- Good, because the blast radius of "ownerRepos" is exactly the owner's account, not every public repo on
  GitHub — rejecting the fully-open option matters here.
- Bad, because it widens CON-04: Jarvis now holds credentials capable of cloning more than one repo, and
  a bug in allow-list resolution is now a path to running tasks against an unintended repository.
- Bad, because disk usage and cleanup of `~/.jarvis/repos/**` become the engine's concern, not just the
  owner's.
- Bad, because letting the dispatcher write `autoAllowedCommands` for a repo means an LLM run can grant
  future runs permission to skip the owner's approval for a shell command — accepted deliberately
  (owner decision, 2026-11-08) in exchange for not hand-editing `jarvis.config.json` per repo; mitigated by
  scoping the write to one allow-listed repo's command list only, never to the repo allow-list itself.

### Confirmation
- RULE: Cloning or resolving a repo path only happens inside `engine/src/infrastructure/git/**`, gated by
  the allow-list check.
  CHECK: `grep -rn "git clone" engine/src | grep -v infrastructure/git`
- RULE: A task naming a repo outside `repos.allow` and outside the owner's account (when
  `allowOwnerRepos` is set) is rejected before any clone or worktree is created.
  CHECK: unit test on repo resolution with a disallowed `owner/name`
- RULE: Jarvis's own repository is never resolvable as a task target.
  CHECK: unit test asserting resolution rejects `repo.path`'s own remote
- RULE: No MCP tool can write to `repos.allow` or `repos.allowOwnerRepos`; only `allowlist.autoAllowedCommands.repos[owner/name]` is dispatcher-writable, and only for a repo already resolvable per the rules above.
  CHECK: unit test that the "add allowed command" use case rejects a repo not currently resolvable, and that no tool/route exists for editing `repos.allow`
