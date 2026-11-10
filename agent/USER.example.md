# Owner preferences

Copy this file to `~/.jarvis/USER.md` and edit it. The engine puts it into the first message of every run,
so changes apply from the next run without a restart. Keep personal data out of git.

## Language

- Chat messages: English
- Artifacts (`context.md`, `spec.md`, `plan.md`, `tasks.md`, `result.md`): English
- Code, identifiers, commit messages, PR text: English

## Detail level

- Chat: short. Result first, details only on request.
- Spec: concise; every requirement one or two lines.
- Questions: one at a time, with options when there are clear alternatives.

## Plan format

- Phases with 3-7 checkbox tasks each.
- Each task names the files it touches.

## Summary format

- What changed (bullets), how it was verified, what is left open.
- No more than 10 lines in chat; the rest goes to `result.md`.

## PR format

- Title: conventional commit style.
- Sections: What, Sources, Checks, Open questions.
- Draft PR; screenshots for UI changes.

## Other

- Anything else Jarvis should always do or avoid.

## Learned

<!--
Written by Jarvis; you may edit it. Lines look like this (an unscoped entry applies everywhere, entries
under `### owner/name` only to that repository). A line you type without the bracket prefix is read as
your own entry.

- m3 [owner · 2026-11-09 10:42] Summaries in Ukrainian, code and PR text in English.

### owner/name

- m4 [owner via T-14 · 2026-11-14 15:58] Keep specs under one page. (src: message 0193…)
- m7 [agent · T-14 · 2026-11-14 16:05 · ✓4 ✗0 · last T-31 2026-11-20 09:12] Dates go through `formatDate()`. (src: lib/date.ts:12, https://github.com/o/r/pull/41#discussion_r1)
-->
