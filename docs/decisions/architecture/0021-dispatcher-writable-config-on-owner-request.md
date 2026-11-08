---
status: accepted
date: 2026-11-08
decision-makers: []  # owner: dispatcher may edit limits/budgets too, not just safe tunables, when the owner asks for it in chat (2026-11-08); drafted by Claude
scope: ["shared/src/config.ts", "engine/src/application/config/**", "shared/src/mcp.ts", "engine/src/presentation/mcp/server.ts", "engine/src/presentation/http/routes/agent-tools.ts"]
supersedes: []
superseded-by: []
---

# ADR-0021: The dispatcher may edit `jarvis.config.json` when the owner asks for it in chat, limits included

## Context and Problem Statement
`jarvis.config.json` (ADR-0006) is owner-edited only; every change today means the owner hand-editing the
file on disk. This session needed `limits.stallMinutes` changed from 10 to 1 purely to test the stall
warning faster, and the owner had to ask Claude Code (outside Jarvis) to patch the file directly — Jarvis
itself has no way to do this from its own chat, even on explicit owner instruction.

`limits.*` (`maxBudgetUsdPerRun`, `dailyBudgetUsd`, `maxTurnsPerRun`, `taskTimeoutMinutes`,
`permissionTimeoutMinutes`, `stallMinutes`, `maxConcurrentWorkers`) are explicitly the brakes against
runaway loops (ADR-0006's own rationale for putting them in config at all). ADR-0019 already made one
exception to "config is owner-only" (`allowlist.autoAllowedCommands.repos[owner/name]`, dispatcher-writable,
scoped to one repo's command list) while explicitly keeping `repos.allow`/`repos.allowOwnerRepos`
owner-only because that boundary controls which repositories Jarvis can touch at all.

## Considered Options
- **Keep config fully owner-edited** (status quo): safest, but the owner must leave the chat to change
  anything, including a harmless timer.
- **Dispatcher can edit only "safe" tunables** (`stallMinutes`, `taskTimeoutMinutes`,
  `permissionTimeoutMinutes`, `maxConcurrentWorkers`, `models.*`, `watch.pollSeconds`,
  `allowlist.autoAllowedCommands`), never the budget/turn caps.
- **Dispatcher can edit any config field the owner asks for, limits and budgets included**, except the
  fields other ADRs already locked down for a specific reason (`repos.allow`, `repos.allowOwnerRepos` —
  ADR-0019; structural fields that would break the running engine or conflict with ADR-0019's own repo
  resolution — `repo.path`, `repo.remote`, `repo.baseBranch`, `engine.*`).

## Decision Outcome
Chosen option: the third — the dispatcher may edit `limits.*` (including budgets and turn/task timeouts),
`models.*`, `watch.pollSeconds`, and top-level `allowlist.autoAllowedCommands`, when the owner asks for it
in the conversation (owner decision, 2026-11-08: "Усі, включно бюджети/таймаути" — explicitly accepting
that this removes the "only a human can raise the ceiling" property ADR-0006 relied on, in exchange for not
leaving the chat to change a number).

- A new dispatcher-only MCP tool, `update_config(patch: Record<string, unknown>)`, applies a partial update
  to `jarvis.config.json`: merge `patch` into the current config, validate the *whole* result against
  `JarvisConfigSchema` (same validation path as a manual edit, ADR-0006), write only if it parses, and
  return the validation error (not a 500) if it doesn't — the dispatcher gets a clear reason to relay to
  the owner, same pattern as `set_task_target_repo`'s `InvalidInputError`.
- **Never writable through this tool**, regardless of what the owner asks in chat: `repos.allow`,
  `repos.allowOwnerRepos` (ADR-0019's own confirmation rule forbids any tool writing these — this ADR does
  not reopen that), `repo.path`, `repo.remote`, `repo.baseBranch` (changing the working repo path from
  inside a running engine is a different, larger change than a limits edit), `engine.port`,
  `engine.claudeBinary` (editing these can break the very process serving the edit). The tool's input
  schema or the use case rejects a patch touching any of these paths with a clear "not editable from chat,
  edit `jarvis.config.json` yourself" message, rather than silently dropping them.
- `allowlist.autoAllowedCommands.repos[owner/name]` keeps its own tool from ADR-0019
  (`set_repo_auto_allowed_commands` or whatever it was implemented as) — `update_config` can still touch
  the top-level `allowlist.autoAllowedCommands` array (the default-repo list) since that was already
  implicitly in scope and nothing in ADR-0019 locked it to owner-only.
- Every successful `update_config` call is journalled (same mechanism as other dispatcher actions) so a
  budget or timeout change made from chat is visible in the task/thread history, not just in the file.
- No undo tool in this ADR: reverting a bad `update_config` call is the owner editing the file back, same
  as today.

### Consequences
- Good, because a harmless timer change (like today's `stallMinutes`) no longer needs the owner to leave
  Jarvis and hand-edit a file.
- Good, because validation reuses the existing Zod schema, so a malformed or out-of-range patch is rejected
  the same way a bad manual edit would be, not silently accepted.
- Bad, because the safety property "only a human can raise the budget/turn ceiling" (ADR-0006's own stated
  reason for these limits existing) is gone: a confused or manipulated dispatcher run that convinces itself
  (or is prompt-injected into believing) the owner asked for a higher budget can now actually raise it.
  Accepted deliberately by the owner for this ADR, not a default any other Jarvis deployment should assume.
- Bad, because `update_config` writes to the same file `repo.path`/`repos.allow` live in; the explicit
  exclusion list above is the only thing stopping scope creep back into ADR-0019's boundary, and it must be
  kept in sync if `JarvisConfigSchema` grows new repo-identity fields later.
- Neutral, because this does not change who can edit `repos.allow`/`allowOwnerRepos` — ADR-0019's boundary
  (which repos Jarvis may touch) is stricter than, and independent from, this ADR's boundary (how Jarvis
  behaves on the repos it's already allowed to touch).

### Confirmation
- RULE: `update_config` is dispatcher-only; no worker tool.
  CHECK: `shared/src/mcp.ts`'s `toolsByRole.worker` does not include `update_config`
- RULE: A patch touching `repo.*`, `repos.allow`, `repos.allowOwnerRepos`, `engine.*` is rejected before
  any write, with a clear message, not silently stripped.
  CHECK: unit test — patch with one of these keys alongside a valid `limits.*` key rejects the whole call
- RULE: A patch that fails `JarvisConfigSchema` validation is rejected with no file write.
  CHECK: unit test — invalid `limits.maxBudgetUsdPerRun` (e.g. negative) leaves the on-disk config
  unchanged
- RULE: A successful `update_config` call is journalled.
  CHECK: unit test asserting a journal entry with the applied patch
