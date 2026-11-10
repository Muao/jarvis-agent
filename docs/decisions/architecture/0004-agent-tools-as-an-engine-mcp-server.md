---
status: accepted
date: 2026-10-26
decision-makers: []  # drafted by Claude 2026-10-26; awaiting Ivan Lapa
scope: ["engine/src/presentation/mcp/**", "shared/src/mcp.ts"]
supersedes: []
superseded-by: []
---

# ADR-0004: Give the dispatcher and workers their capabilities as tools of a Jarvis MCP server, including the permission prompt tool

## Context and Problem Statement
The dispatcher and workers must change Jarvis state (create a task, report a stage, ask the owner,
submit spec for approval) and the owner must answer permission prompts from the web. Letting the model
write `state.json` or the database directly breaks the one-writer rule (ST-02) and makes forbidden actions
possible. Claude Code loads tools from MCP servers given with `--mcp-config`.

## Considered Options
- A stdio MCP server started by each `claude -p` run, which calls the engine's local HTTP API; identity (thread id, task id, role) from env set by the engine
- The model writes files the engine watches
- The model calls the engine with `curl`

## Decision Outcome
Chosen option: "Stdio MCP server that calls the engine API", because the tool list is the capability
boundary per role, identity is fixed by the engine at spawn time, and every rule stays in engine use cases.

Tools by role (names indicative, final list in the engine spec):
- Dispatcher: `create_task`, `list_tasks`, `cancel_task`, `send_to_task`, `reply` (to the thread).
- Worker: `report_stage`, `ask_owner`, `submit_spec_for_approval`, `open_pr`, `log_note`. (`report_checks` and
  `report_pr` were retired by ADR-0022; the current list is `toolsByRole` in `shared/src/mcp.ts`.)
- Both: `approve` — the `--permission-prompt-tool`; blocks until the owner answers in the UI or the timeout from config denies.

There is no tool to merge, push to `main`, or touch another task. Later records added tools on top of
this list — per-repo allowed commands (ADR-0012), `remember` and `update_config` incl. limits
(ADR-0013), the UI-check tools (ADR-0014), `comment_on_pr` (ADR-0018) — each with its own boundary;
`shared/src/mcp.ts` is the authoritative per-role tool list.

### Consequences
- Good, because one writer (the engine) owns state; artifacts stay files written by the worker in its worktree.
- Good, because the same tools serve web and Slack.
- Bad, because the engine HTTP API must be up for any run; tools return a clear error otherwise.

### Confirmation
- RULE: Role, task id and thread id are read only from env set by the engine; no tool accepts them as arguments.
  CHECK: unit test on tool schemas + reviewer
- RULE: Tool sets per role match `shared/src/mcp.ts`; adding a tool needs an ADR that names it.
  CHECK: `engine/src/presentation/mcp/tools.test.ts`
