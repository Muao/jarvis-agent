---
status: accepted
date: 2026-10-26
decision-makers: []  # owner: chat in the admin first, Slack with threads later (2026-10-26); drafted by Claude
scope: ["engine/src/application/ports/owner-channel*", "engine/src/presentation/http/**", "engine/src/presentation/slack/**", "web/src/features/chat/**"]
supersedes: []
superseded-by: []
---

# ADR-0006: Talk to the owner through an `OwnerChannel` port — web chat with threads in iteration 1, Slack threads via Socket Mode in iteration 2

## Context and Problem Statement
The owner wants to talk to Jarvis in the admin first and later in Slack, where each top-level message
opens a thread and the whole conversation (replies, questions, approvals, progress) continues in it. The
web chat must not be a throwaway: Slack has to plug into the same model.

## Considered Options
- Domain model `Thread` → `Message`; `OwnerChannel` port with adapters `WebChannel` (HTTP + SSE) and `SlackChannel` (Bolt, Socket Mode); a thread can be mirrored to Slack by storing the Slack `thread_ts`
- Build Slack first with the Claude Code channels plugin (research preview)
- Web chat only

## Decision Outcome
Chosen option: "`OwnerChannel` port with web and Slack adapters", because threads are a domain concept
from day one, the web chat is useful on its own (and doubles as the admin), and Slack becomes a
Presentation adapter without changes to use cases. Socket Mode needs no public URL, fits the laptop
(CON-03) and the free Slack plan (CON-05). The Slack adapter adds `@slack/bolt` — accepted together
with this ADR when iteration 2 starts.

### Consequences
- Good, because one conversation model serves both channels; decision buttons and permission cards map to Slack Block Kit actions.
- Good, because no dependency on the channels research preview.
- Bad, because iteration 1 webinar flow happens in the browser, not in a messenger.

### Confirmation
- RULE: Use cases talk to the owner only through the `OwnerChannel` port; no use case imports a web or Slack adapter.
  CHECK: `engine/src/architecture.test.ts`
- RULE: Every owner message belongs to exactly one `Thread`; a reply always targets a thread id.
  CHECK: domain unit test
