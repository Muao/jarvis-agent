---
status: accepted
date: 2026-11-08
decision-makers: []  # owner: append-only learned facts in USER.md, not a new file (2026-11-08); drafted by Claude
scope: ["agent/USER.example.md", "agent/README.md", "engine/src/application/ports/profile-store.ts", "engine/src/infrastructure/claude/**", "shared/src/mcp.ts", "engine/src/presentation/mcp/server.ts"]
supersedes: []
superseded-by: []
---

# ADR-0020: Dispatcher-writable learned facts, appended to `USER.md`, not a separate memory file

## Context and Problem Statement
The dispatcher starts every new thread with no memory of facts established earlier — e.g. "the QuickBlog
repo is `burnjohn/quick-blog`, not `QuickBlog`". This was just hit live: the dispatcher correctly asked
the owner to confirm a guessed repo slug, the owner confirmed a wrong guess, and `create_task` failed
against GitHub, because nothing durable recorded the correct slug from the earlier thread that *did*
establish it (ADR-0019's `repos.allow` entry, set directly by the owner, never round-trips back into
anything the dispatcher reads).

`SOUL.md` (agent identity/behavior, ADR-0011) and `USER.md` (owner preferences, PRF-02/PRF-03, read fresh
into the first message of every run) are the only two personal files today. Neither is dispatcher-writable.

## Considered Options
- **A new `MEMORY.md`**, dispatcher-writable, injected the same way as `USER.md`.
- **Extend `USER.md`** with a dispatcher-writable, append-only `## Learned` section, read the same way it
  already is (no new injection plumbing).
- **Put learned facts in `jarvis.config.json`** as free-form data.

## Decision Outcome
Chosen option: "Extend `USER.md`" (owner decision, 2026-11-08) — `SOUL.md` stays the agent's own
behavior/principles, fully off-limits; `USER.md` already means "things about the owner and their
projects", so a learned-facts section there is the same category of content, not a new one, and it reuses
the existing injection path (`ProfileStore.userPreferences()`, read fresh every run per PRF-03) with no new
file-watching or wiring.

- `USER.md` gains a `## Learned` heading (present even when empty, e.g. `USER.example.md` ships with an
  empty one so the structure is discoverable).
- A new dispatcher-only MCP tool, `remember(fact: string)`, **appends** one bullet line to `## Learned`
  and nothing else. It cannot rewrite, reorder, or delete any other line of `USER.md` — the rest of the
  file is the owner's, edited only by the owner (same guarantee as today).
- Implementation: `ProfileStore` (or a new narrow port next to it) gets an `appendLearned(fact: string)`
  method; the infrastructure adapter opens `~/.jarvis/USER.md`, inserts the bullet under `## Learned`
  (creating the heading at end-of-file if the owner's copy predates this ADR and lacks it), and writes the
  file back — never touching text outside that section.
- Worker gets no `remember` tool (dispatcher-only, like `set_task_target_repo`/the per-repo
  `autoAllowedCommands` tool from ADR-0019) — the dispatcher is the one holding the owner conversation
  where facts surface; a worker run recording facts would mix task-scoped findings with durable
  owner/project knowledge.
- No size cap or expiry in this ADR; if `## Learned` grows unwieldy that is a follow-up (summarization or
  pruning), not blocking this capability.

### Consequences
- Good, because a fact established once (a repo slug, a naming convention, a standing instruction) survives
  into new threads without the owner repeating it or the dispatcher re-guessing it.
- Good, because the append-only contract means a bad or hallucinated "fact" is visible and removable (owner
  reads/edits `USER.md` like today) rather than silently corrupting the rest of the profile.
- Bad, because this is the second capability (after ADR-0019's per-repo `autoAllowedCommands`) where an LLM
  run writes its own future context without a human in the loop per-write — accepted deliberately, same
  reasoning as ADR-0019: scoped to one owner-visible, owner-editable file, never code or secrets.
- Bad, because `## Learned` can accumulate stale or wrong facts (e.g. a repo renamed later) with nothing
  pruning them; mitigated only by the file being human-readable and human-editable, not automatically.

### Confirmation
- RULE: Only the dispatcher role has the `remember` tool; workers do not.
  CHECK: `shared/src/mcp.ts`'s `toolsByRole.worker` does not include `remember`
- RULE: `remember` only ever appends under `## Learned`; it never rewrites bytes outside that section.
  CHECK: unit test — a `USER.md` with owner-authored content before/after `## Learned` is byte-identical
  outside the section after `remember` runs
- RULE: A fresh `USER.md` with no `## Learned` heading gets one created, not an error.
  CHECK: unit test on a profile file predating this ADR
