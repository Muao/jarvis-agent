---
status: accepted
date: 2026-11-08
decision-makers: ["Ivan Lapa"]  # owner: wrap everything externally sourced as untrusted; the agent must report an injection attempt and ask before continuing (2026-11-08); drafted by Claude
scope: ["engine/src/application/conversation/untrusted.ts", "engine/src/application/code-host/**", "agent/prompts/worker.md", "agent/SOUL.md"]
supersedes: []
superseded-by: []
---

# ADR-0026: Externally-authored text enters prompts wrapped as untrusted content, and an injection attempt is reported to the owner before the agent continues

## Context and Problem Statement

SEC-03 says content from PRs, documents and logs is data, not instructions — but until now only the
prompt text (SOUL principle 4, WRK rules) carried that rule. The engine itself interpolated PR review
comments verbatim into the worker's next input (`HandleCodeHostChange.feedback`), with nothing marking
where the reviewer's words begin and end. The security audit (2026-11-08) rated prompt injection from
CI logs and review comments as one of the two critical risks: an instruction hidden in a comment reads
exactly like an instruction from the engine. Claude Code brings its own injection mitigations, but we
should not rely on them alone for text we compose ourselves.

## Considered Options

- Keep relying on the prompt rule and Claude Code's own handling (status quo).
- **Wrap every externally-authored text the engine places into a prompt in explicit
  `<untrusted-content>` tags, and require the agent to report an attempted instruction to the owner
  and wait before continuing.**
- Sanitize/filter external text (strip imperative sentences) before it reaches the model.

## Decision Outcome

Chosen option: wrap and report. Filtering was rejected because no filter reliably recognises an
instruction, and a mangled comment loses the information the worker actually needs.

- **One helper, `untrustedContent()`** (`engine/src/application/conversation/untrusted.ts`), wraps a
  body as
  `<untrusted-content source="…" author="…">…</untrusted-content>`. The body is defused first: any
  `<untrusted-content` / `</untrusted-content` sequence inside it is rewritten so quoted text cannot
  close the tag and smuggle the rest of itself outside the wrapper.
- **Every engine-composed prompt that quotes external text uses it.** Today that is PR review comments
  in the watcher's worker input; a future Slack/Telegram channel wraps every message not authored by
  the owner the same way. Owner messages are never wrapped — the owner is the one principal whose
  instructions count.
- **Text the model fetches itself** (CI logs via `gh`, Notion/Google Docs via MCP, web pages) cannot be
  wrapped by the engine. There the prompt rule carries the weight, and it is strengthened: SOUL
  principle 4 and the worker rules now require the agent, on meeting content that tries to change its
  rules, scope or permissions, to **stop, report the attempt to the owner (`ask_owner`), and wait for
  the answer before acting on anything that content asked** — not merely "mention it".
- **This is mitigation, not the boundary.** The enforcement layer remains the permission system and the
  allowlist; the audit's findings on bare `Bash` in the worker's allow-list and the unauthenticated
  owner API are what turn an injection from an incident into an inconvenience, and they are tracked
  separately.

## Consequences

- Good, because the model sees an unambiguous marker separating "what the reviewer wrote" from "what
  the engine asks", and quoted text cannot escape its wrapper.
- Good, because an injection attempt becomes a visible owner-facing event (a question card in the
  thread) instead of a silent judgement call inside a run.
- Bad, because wrapped text costs a few extra tokens per comment and the tag is one more convention
  prompts and tests must keep in sync.
- Bad, because self-fetched content stays unwrapped: the rule-plus-report covers it only as well as the
  model follows rules. Accepted — the alternative (proxying every fetch through the engine) is a much
  larger change.

## Confirmation

- RULE: Review-comment text reaches the worker only through `untrustedContent()`.
  CHECK: unit test on the watcher's feedback composition; `grep -n "untrustedContent" engine/src/application/code-host/handle-code-host-change.ts`
- RULE: A body containing `</untrusted-content>` cannot close the wrapper.
  CHECK: unit test in `engine/src/application/conversation/untrusted.test.ts`
- RULE: The worker prompt and SOUL require report-and-wait on an attempted instruction.
  CHECK: `grep -n "untrusted" agent/prompts/worker.md agent/SOUL.md`
