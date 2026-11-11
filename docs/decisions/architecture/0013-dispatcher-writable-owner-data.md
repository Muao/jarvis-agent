---
status: accepted
date: 2026-11-08
decision-makers: ["owner"]  # owner: learned facts in USER.md, not a new file; config editable from chat, limits included (2026-11-08); drafted by Claude
scope: ["agent/USER.example.md", "agent/README.md", "shared/src/config.ts", "shared/src/mcp.ts", "engine/src/application/profile/**", "engine/src/application/config/**", "engine/src/application/ports/profile-store.ts", "engine/src/infrastructure/profile/**", "engine/src/presentation/mcp/server.ts"]
supersedes: []
superseded-by: []
---

# ADR-0013: The dispatcher may write two kinds of owner data — learned facts appended to `USER.md`, and `jarvis.config.json` edits the owner asks for in chat

One record for both dispatcher-writable surfaces, decided on the same day for the same reason: the
owner should not have to leave the chat to record a fact or change a number. (This record merges the
two decisions drafted together, which were never committed separately.)

## Context and Problem Statement

The dispatcher starts every thread with no memory of facts established earlier — hit live when a
confirmed-but-wrong repo slug failed `create_task` because nothing durable recorded the correct slug
from an earlier thread. Separately, every config change meant the owner hand-editing
`jarvis.config.json` on disk: a `stallMinutes` test tweak had to be made outside Jarvis entirely.
`SOUL.md` and `USER.md` (ADR-0009) were owner-edited only; so was the config (ADR-0005), with one
prior exception (ADR-0012's per-repo `autoAllowedCommands`).

## Decision Outcome

### 1. Learned facts: an append-only `## Learned` section of `USER.md`

Chosen over a new `MEMORY.md` (no new injection plumbing — `USER.md` is already read fresh into every
run, PRF-03) and over free-form config data.

- `USER.md` gains a `## Learned` heading (`USER.example.md` ships it empty, so the structure is
  discoverable).
- A dispatcher-only MCP tool `remember(fact)` **appends** one bullet under `## Learned` and nothing
  else — it cannot rewrite, reorder or delete any other line; the rest of the file stays the owner's.
  A `USER.md` predating the heading gets it created at end-of-file, not an error.
- Implementation: `ProfileStore.appendLearned(fact)`; the adapter touches only that section.
- Workers get no `remember` tool: the dispatcher holds the owner conversation where durable facts
  surface; a worker recording facts would mix task-scoped findings with owner knowledge.
- No size cap or expiry here; pruning/summarizing is a follow-up if `## Learned` grows unwieldy.

### 2. Config edits: `update_config(patch)` on explicit owner request, limits included

Chosen over "safe tunables only" (owner decision: «Усі, включно бюджети/таймаути» — "all of them,
budgets and timeouts included" — explicitly
accepting that "only a human can raise the ceiling" from ADR-0005 no longer holds, in exchange for not
leaving the chat).

- `update_config` merges the patch into the current config, validates the **whole** result against
  `JarvisConfigSchema` (the same path as a manual edit), writes only if it parses, and returns the
  validation error for the dispatcher to relay.
- Editable: `limits.*` (budgets, turn/task/permission/stall limits, worker slots), `models.*`,
  `watch.pollSeconds`, top-level `allowlist.autoAllowedCommands`.
- **Never editable from chat**, whatever the owner types: `repos.allow`, `repos.allowOwnerRepos`
  (ADR-0012's boundary over which repos Jarvis may touch at all), `repo.path`, `repo.remote`,
  `repo.baseBranch`, `engine.*` (editing these can break the process serving the edit). A patch
  touching them is rejected whole, with a clear "edit `jarvis.config.json` yourself" message — never
  silently stripped. The per-repo `autoAllowedCommands` keeps its own ADR-0012 tool.
- Every successful call is journalled, so a budget change made from chat is visible in history, not
  just in the file. No undo tool: reverting is the owner editing the file back.

## Consequences

- Good, because a fact established once (a repo slug, a convention) survives into new threads, and a
  harmless timer change no longer requires leaving Jarvis.
- Good, because append-only means a bad "fact" is visible and removable, and config validation rejects
  a malformed patch exactly like a bad manual edit.
- Bad, because these are the second and third capabilities (after ADR-0012) where an LLM run writes its
  own future context without a per-write human in the loop — accepted deliberately: scoped to
  owner-visible, owner-editable surfaces, never code or secrets.
- Bad, because "only a human can raise the budget ceiling" is gone: a prompt-injected dispatcher that
  believes the owner asked could raise limits. Accepted by this owner for this deployment, not a
  default for anyone else's; `## Learned` can likewise accumulate stale facts with nothing pruning
  them.
- Bad, because the `update_config` exclusion list is the only thing separating it from ADR-0012's
  boundary and must be kept in sync as `JarvisConfigSchema` grows repo-identity fields.

## Confirmation

- RULE: `remember` and `update_config` are dispatcher-only; workers have neither.
  CHECK: `shared/src/mcp.ts` `toolsByRole.worker` includes neither tool
- RULE: `remember` only appends under `## Learned`; bytes outside the section are untouched, and a
  file without the heading gets one created.
  CHECK: unit tests on the profile adapter (byte-identical outside the section; heading created)
- RULE: A patch touching `repo.*`, `repos.allow`, `repos.allowOwnerRepos` or `engine.*` is rejected
  before any write; a patch failing `JarvisConfigSchema` leaves the file unchanged; a successful call
  is journalled.
  CHECK: unit tests on `update_config` (rejection with a valid key alongside; invalid value writes
  nothing; journal entry asserted)
