---
name: sdd-flow
description: The artifact contract of a Jarvis task - what context.md, spec.md, plan.md, tasks.md and result.md must contain, how requirements cite sources, and the format of acceptance criteria. Use when writing or checking any of the five task artifacts.
---

# SDD artifact contract

A task has five files in `<artifactsDir>` (from the run context). Start each from `${CLAUDE_PLUGIN_ROOT}/templates/<name>.md`.
Write in the owner's language (see the owner preferences); keep identifiers and code in English.
The files are the task's memory across runs: a resumed run reads them instead of redoing work. Keep them current.

## Source references

Every claim that comes from outside the task description carries a reference in square brackets:

- `[link]` - a URL exactly as given (design, Notion, Google Docs, issue, PR)
- `[repo:path]` or `[repo:path:line]` - a file in the target repository (`AGENTS.md`, docs, code)
- `[ctx:R2]` - requirement R2 in `context.md`
- `[task]` - the task description or an owner message

A requirement with no reference is an error. If it is your own inference, mark it `[inferred]` and list it
in open questions.

## context.md

- **Sources**: one row per source: reference, kind, status (`read` or `UNAVAILABLE: reason`).
- **Requirements**: numbered `R1…`, each one sentence, each with a reference, marked `explicit` or `inferred`.
- **Repository rules**: check commands, conventions, ADRs that apply, each with `[repo:…]`.
- **Open questions**: what is unknown or contradictory. Empty is allowed; hidden is not.

## spec.md

- **Goal**: what is built and why, in two or three sentences.
- **Scope**: in scope / out of scope.
- **Requirements**: numbered `FR1…`, each citing context requirements (`[ctx:R…]`) or `[task]`.
- **Acceptance criteria**: numbered `AC1…`, each testable, in EARS form:
  `When <trigger>, the <system> shall <response>.` (also `While <state>…`, `If <condition>, then…`, or the plain
  `The <system> shall…`). Each names the `FR` it verifies. No criterion without a way to check it.
- **Design**: for UI work, the design source and the screens or states it defines.
- **Constraints**: ADRs, dependency rules, performance or security limits from the repository.

No implementation detail (the "how") belongs here.

## plan.md

- **Approach**: how the spec will be met, in a few paragraphs, with the reasoning for non-obvious choices.
- **Changes**: files and modules touched, created or removed.
- **Verification**: check commands from the repository's `AGENTS.md` (verbatim), tests to add, and for UI the
  page to compare with the design.
- **Risks**: what could go wrong and what is assumed.

## tasks.md

An ordered checkbox list. Each task is one commit-sized unit:

```
- [ ] T1 <imperative title> - files: `a.ts`, `b.ts` - serves: AC1, AC2 - done when: <observable condition>
```

The worker ticks `[x]` when the task is done and verified. Tasks only depend on earlier ones.

## result.md

Written at the end of the PR stage and updated after each fix round: outcome, PR link, checks run and results,
acceptance criteria status (met / not met / partially, with evidence), deviations from the plan, open items.
State what was not verified. Never record a check that was not run.
