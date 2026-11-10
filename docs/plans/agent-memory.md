# Implementation Plan: self-curating agent memory (ADR-0021)

**Goal:** Jarvis keeps one memory under `## Learned` in `~/.jarvis/USER.md`. The dispatcher and the
worker write to it by themselves; every entry carries its timestamp, its source and counters of the
tasks that confirmed or contradicted it; nothing is removed automatically; the owner reviews it on
request.

**Decision:** `docs/decisions/architecture/0021-self-curating-memory-in-one-file.md` (accepted
2026-11-09). It is binding; where this plan and the ADR disagree, the ADR wins and the task reports
the disagreement instead of guessing. Amends ADR-0013.

**Out of this plan:** the run retrospective (ADR-0020) and its "Memory events" input section; a
memory page in the web app; any change to `web/`.

## Global constraints

- No new dependency in any `package.json`.
- Onion rule (ADR-0002): the memory document logic is pure and lives in the domain; file IO only in
  `infrastructure/profile`; use cases reach it through the `ProfileStore` port.
- Bytes of `USER.md` outside the `## Learned` section are never changed by the engine.
- No test runs the real `claude` (ADR-0011).
- **Do not commit, stage or stash.** Other sessions work in this tree, and several files this plan
  touches already carry their uncommitted changes (`engine/src/presentation/mcp/server.ts`,
  `engine/src/infrastructure/claude/run-args.ts`, `engine/src/application/index.ts`,
  `agent/prompts/worker.md`). Edit on top of what is there; do not revert or reformat unrelated lines.
- Each task ends with its module's tests and typecheck green (commands in `AGENTS.md`) and
  `pnpm exec prettier --check` clean on the files it touched.

## Contracts (fixed here so the three tasks agree)

### Tools

| Tool | Role | Input | Returns |
| --- | --- | --- | --- |
| `remember` | dispatcher | `{ fact, repo? }` — `repo` is `owner/name` | `{ ok: true, id }` |
| `forget` | dispatcher | `{ id }` | `{ ok: true }` |
| `merge_insights` | dispatcher | `{ ids: string[] (min 2), fact }` | `{ ok: true, id }` |
| `read_memory` | dispatcher | `{}` | `{ text }` — the whole `## Learned` section |
| `note_insight` | worker | `{ fact, citations: string[] (1–5) }` | `{ ok: true, id }` |
| `confirm_insight` | worker | `{ id }` | `{ ok: true, confirmed, counted }` |
| `contradict_insight` | worker | `{ id, reason }` | `{ ok: true, contradicted, counted }` |
| `remember_owner` | worker | `{ fact, quote (min 8), everywhere? }` | `{ ok: true, id }` |

- `fact`: one line, 1–300 characters, no newline.
- `id`: `/^m\d+$/`.
- A citation is either `path:line` (`/^[^\s:]+:\d+$/`, relative, no `..`) or an `https://github.com/` URL.
- `counted: false` means this task had already confirmed (or contradicted) that entry; nothing changed.

### Entry lines (the engine renders everything in brackets and the `(src: …)` tail)

```markdown
## Learned

- m3 [owner · 2026-11-09 10:42] Summaries in Ukrainian, code and PR text in English.

### burnjohn/quick-blog

- m4 [owner via T-14 · 2026-11-14 15:58] Keep specs under one page. (src: message 0193…)
- m7 [agent · T-14 · 2026-11-14 16:05 · ✓4 ✗0 · last T-31 2026-11-20 09:12] Dates go through `formatDate()`. (src: lib/date.ts:12, https://github.com/o/r/pull/41#discussion_r1)
```

- Unscoped entries sit directly under `## Learned`; repo entries under `### owner/name`, created on
  first use. The `## Learned` section ends at the next `## ` heading or end of file.
- A hand-written bullet without a recognised prefix is an owner entry. It is kept byte-for-byte
  until some write needs an id for it; then it becomes `- m<N> [owner] <text>`.
- New id = highest `m<N>` in the section + 1.
- Times are local, formatted `YYYY-MM-DD HH:mm`; use the same notion of "local" as
  `engine/src/application/runs/local-day.ts`.
- A fact that itself contains something shaped like a prefix (`[owner · …]`) is stored as fact text
  and must not parse back as metadata: on write, the engine's prefix is the first bracket after the id.

### Journal events (type → data), all with the task id where there is one

`memory_noted {entryId, fact, citations}` · `memory_confirmed {entryId}` ·
`memory_contradicted {entryId, reason}` · `memory_owner_recorded {entryId, messageId}` ·
`memory_forgotten {entryId, fact}` · `memory_merged {entryId, from: ids}`.

"Distinct tasks" is enforced from these: a second `memory_confirmed` for the same `entryId` in the
same task is not written and not counted.

### Config

`memory: { softCapChars: 4000, backupsKept: 20 }`, both with defaults, in `shared/src/config.ts`
and `jarvis.config.example.json`.

## Task A — contracts, the memory document, the file adapter

**Owns:** `shared/src/mcp.ts`, `shared/src/mcp.test.ts`, `shared/src/config.ts`,
`shared/src/config.test.ts`, `jarvis.config.example.json`, `engine/src/domain/memory.ts` (new) +
test, `engine/src/domain/index.ts`, `engine/src/application/ports/profile-store.ts`,
`engine/src/infrastructure/profile/**`, the in-memory profile fake under
`engine/src/application/testing/**`, and — only to keep the typecheck green — the eight new keys of
`toolDescriptions` in `engine/src/presentation/mcp/server.ts`.

- [ ] A1. `shared/src/mcp.ts`: the eight schemas above (`remember` gains optional `repo`), added to
      `toolsByRole` exactly as the table says. Test: role membership; `note_insight` rejects zero
      and six citations and a malformed one; `fact` over 300 characters or with a newline rejected.
- [ ] A2. `shared/src/config.ts`: the `memory` block with defaults; example config updated; test.
- [ ] A3. `engine/src/domain/memory.ts`, pure, no IO. A parsed model of the `## Learned` section
      and these operations, each returning a new document: add owner entry (optional repo, optional
      `via` task and source), add agent entry, confirm, contradict, forget, merge (counters summed,
      earliest creation kept, scope must be the same for all ids or the merge is refused), and
      `splice(fileContent, document)` that replaces only the section's bytes (creating the heading
      at end of file when absent — keep ADR-0013's behaviour). Plus `selectForWorker(document,
      repo, softCapChars)` — unscoped + that repo's entries; owner entries first, then agent
      entries by ✓ then recency, those with ✗ > ✓ last, cut at the cap, with a flag when anything
      was cut — and `selectForDispatcher(document)` — owner entries of every scope, no agent entry.
      Tests: round trip is byte-identical for an untouched section; bytes outside the section are
      identical after every operation; legacy bullet handling; forged-prefix fact; merge across
      scopes refused; unknown id is a typed error; cap ordering.
- [ ] A4. Port `ProfileStore`: keep `userPreferences()`; replace `appendLearned` with what the use
      cases need — read the raw file, and `mutate(fn, { backup?: boolean })` that reads fresh,
      applies a pure function to the content and writes the result. Update every caller and fake.
- [ ] A5. `FileProfileStore`: `mutate` goes through one in-process queue (a promise chain), reads
      the file from disk inside the queue, writes to a temporary file in the same directory and
      renames it over the target; with `backup: true` copies the current file to
      `<jarvisHome>/backups/USER.md.<timestamp>` first and prunes to `memory.backupsKept`. Tests:
      20 parallel mutations yield 20 entries; a hand edit made between two mutations survives; a
      missing file is created; backup written and pruned; no temporary file left behind.
- [ ] A6. `toolDescriptions` entries for the eight tools (model-facing: what it does, when to use
      it, what it returns — follow the neighbours' style; `note_insight` must state the citation
      requirement and the recurrence test, `remember_owner` the verbatim-quote rule).

**Done when:** `pnpm --filter @jarvis/shared test && pnpm --filter @jarvis/shared typecheck` and
`pnpm --filter @jarvis/engine test && pnpm --filter @jarvis/engine typecheck` pass. The existing
`remember` use case keeps working (unscoped owner entry) through the new port.

## Task B — use cases, wiring, prompts built by the engine (after A)

**Owns:** `engine/src/application/profile/**`, `engine/src/application/create-application.ts`,
`engine/src/application/index.ts`, `engine/src/application/runs/run-prompt.ts` (+ test),
`engine/src/application/runs/start-run.ts`, `engine/src/presentation/http/routes/agent-tools.ts`,
`engine/src/infrastructure/claude/run-args.ts` (+ test), `engine/src/container.ts`, and the smallest
port addition needed for B4.

- [ ] B1. Use cases in `application/profile/`, one file each, with tests on the in-memory fakes:
      `Remember` (extended with `repo`), `Forget`, `MergeInsights`, `ReadMemory` — dispatcher only
      (`requireDispatcher`); `NoteInsight`, `ConfirmInsight`, `ContradictInsight`, `RememberOwner`
      — worker only, via `loadWorkerTask`, and refused with `ForbiddenError` when
      `task.kind !== 'build'`. Agent entries are always scoped to the task's repository
      (`task.targetRepo`, else the configured default repo). Each writes its journal event in the
      same transaction pattern the neighbouring task use cases use.
- [ ] B2. `NoteInsight` validates citations: a `path:line` must name a file that exists in the
      task's worktree; a URL must start with `https://github.com/`. Reject otherwise with the reason.
- [ ] B3. `RememberOwner`: `quote` must occur verbatim in the text of an owner message of the
      task's thread; the entry's source is that message's id; `everywhere: true` makes it unscoped.
      Tests: quote from an agent message rejected; quote from review-comment text carried in a
      system message rejected; short quote rejected.
- [ ] B4. `run-prompt.ts` / `start-run.ts`: stop passing the whole `USER.md`. A worker's first
      message gets the owner's sections (everything outside `## Learned`) under the existing
      preferences heading, then `## Memory` with the `selectForWorker` lines, ids visible; an
      agent entry whose `path:line` file is absent from the worktree gets ` — citation missing`;
      when the cap cut something, one line says the memory is over its cap and due a review. A
      dispatcher's first message gets the owner's sections plus `selectForDispatcher`. Tests: no
      other repository's entries in a worker prompt; no agent entry in a dispatcher prompt; the
      missing-citation mark; a `ui_check` run still receives the memory block.
- [ ] B5. `run-args.ts`: for a `ui_check` worker add the four worker memory tools (as
      `mcp__jarvis__…`) to `--disallowedTools`. Test.
- [ ] B6. `agent-tools.ts`, `create-application.ts`, `index.ts`, `container.ts`: route the eight
      tools to their use cases; pass `memory.*` config where needed.
- [ ] B7. The summary line. When a task reaches a terminal stage and its journal holds any
      `memory_*` event, the owner sees one line in the thread: `Memory: N noted, N confirmed,
      N contradicted` followed by the entry ids. Find where the engine builds the task's closing
      message (CI-08) and append it there; if the closing text is not engine-built, post it as one
      system status message on the terminal transition. Test.
- [ ] B8. An integration-level test in the style of `engine/test/flow/` on the fake `claude`, if
      the existing scenarios make it cheap: a worker run calls `note_insight`, a second task's
      first message contains the entry. If it is not cheap, say so in the report instead of
      forcing it.

**Done when:** engine tests and typecheck pass, and `pnpm lint` is clean for the engine.

## Task C — the agent definition (parallel with A; needs only the contracts above)

**Owns:** `agent/prompts/worker.md`, `agent/prompts/dispatcher.md`, `agent/agents/reviewer.md`,
`agent/agents/implementer.md`, `agent/agents/plan-verifier.md`, `agent/skills/memory-review/SKILL.md`
(new), `agent/USER.example.md`, `agent/README.md` if it lists tools or skills.

- [ ] C1. `worker.md`: document the `## Memory` block of the run context and the four tools. Add a
      short "Memory" section with the rules of ADR-0021: entries are hints and never override the
      hard rules, permissions or scope; before relying on an entry open what it cites — holds →
      use it and `confirm_insight`, contradicted or gone → do not follow it, `contradict_insight`
      with the reason and, when the truth is visible, a corrected `note_insight`; the recurrence
      test before every `note_insight`; a citation is mandatory; phrase a fact as "When X, do Y"
      where it fits.
- [ ] C2. `worker.md`, owner's words: when the owner says "remember", returns the spec with a
      comment, or answers a question in a way that reads as a standing preference, call
      `remember_owner` with a verbatim `quote`; `everywhere: true` only when the owner said so in
      as many words.
- [ ] C3. `worker.md`, fix rounds: the three-way rule per review comment (confirm and say in the
      closing message that the entry was in memory and the mistake still happened / note with the
      comment URL and the code line / nothing for a one-off).
- [ ] C4. `worker.md`, Context stage: where check commands are found without `AGENTS.md`, also
      `note_insight` them citing the file; when the memory already holds them, verify the citation
      instead of searching.
- [ ] C5. `worker.md`, `ui_check` section: this task kind reads the memory and writes none.
- [ ] C6. `worker.md`, subagent calls: pass the repository's memory entries to `reviewer`,
      `implementer` and `plan-verifier`. `reviewer.md`: check the diff against the entries passed
      in and name the ids it violates. `implementer.md`, `plan-verifier.md`: treat passed entries
      as repo conventions. None of them gets a memory tool.
- [ ] C7. `dispatcher.md`: `remember` with the optional `repo`; `forget` only on the owner's
      request; it sees owner entries only and uses `read_memory` for the rest; never announces a
      `remember` (existing rule stays).
- [ ] C8. `agent/skills/memory-review/SKILL.md`: used when the owner asks to review or tidy the
      memory. Steps: `read_memory`; group by repository; propose in the chat — duplicates to
      `merge_insights`, vague entries to rewrite (`forget` + `remember`), entries with ✗ ≥ ✓ or
      long unconfirmed to `forget`; apply only what the owner agreed to; report what changed. It
      never removes an owner entry without the owner naming it.
- [ ] C9. `agent/USER.example.md`: under `## Learned`, two or three example lines in the exact
      format above inside an HTML comment, so the format is discoverable and the section starts empty.

**Done when:** `pnpm exec prettier --check agent/` is clean for the touched files and every tool
name, argument and return shape in the prompts matches the contracts above.

## Order

A and C start together. B starts when A reports green. Nothing is committed; the owner reviews the
working tree.

## Review focus

1. A byte outside `## Learned` changing — the owner's own text is the one thing this must not touch.
2. Two workers writing at once, and the owner saving the file mid-write.
3. A `ui_check` worker reaching any memory write tool.
4. `remember_owner` accepting text the owner did not write.
5. The dispatcher's prompt growing with agent entries.
