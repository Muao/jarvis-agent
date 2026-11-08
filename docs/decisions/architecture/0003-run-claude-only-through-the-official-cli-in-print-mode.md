---
status: accepted
date: 2026-10-26
decision-makers: []  # drafted by Claude 2026-10-26; awaiting Ivan Lapa
scope: ["engine/src/infrastructure/claude/**", "engine/src/application/**"]
supersedes: []
superseded-by: []
---

# ADR-0003: Run Claude only through the official `claude` CLI in print mode with stream-json, on the owner's subscription

## Context and Problem Statement
Jarvis must run on the owner's Claude Max subscription, with no API billing (CON-01). The Agent SDK and
third-party code that reuses the subscription's OAuth token are not allowed for this; the official CLI
is. The earlier idea — an interactive dispatcher session with a Slack channel plugin and workers in tmux —
depends on the channels research preview and a development flag, cannot be driven from a web UI, and
gives no structured log for the admin console. The owner now wants an engine, a web app and a database.

Facts verified in the CLI reference (2026-10-26): print mode supports `--output-format stream-json`,
`--input-format stream-json` (a long-lived process that accepts user messages on stdin),
`--resume` / `--session-id`, `--max-turns`, `--max-budget-usd` (client-side estimate),
`--permission-prompt-tool mcp__<server>__<tool>`, `--mcp-config` + `--strict-mcp-config`,
`--append-system-prompt-file`, `--settings`, `--model`. If `ANTHROPIC_API_KEY` is present, print mode
uses it silently and bills the API.

## Considered Options
- Engine spawns `claude -p` processes with stream-json in/out; one dispatcher session per thread, one worker process per task run
- Interactive dispatcher session with a channel plugin; workers as interactive sessions in tmux
- Agent SDK with an API key

## Decision Outcome
Chosen option: "Engine spawns `claude -p` with stream-json", because it keeps the subscription,
needs no research-preview flags, and every event (assistant text, tool call, tool result, usage) arrives
as JSON the engine can store, stream to the web console and use for limits.

Process model:
- **Dispatcher turn.** For each owner message in a thread the engine runs `claude -p --resume <thread-session>` with the dispatcher prompt and the Jarvis MCP tools (ADR-0004). The dispatcher never edits code (`--allowedTools` excludes Edit/Write/Bash outside its tools).
- **Worker run.** For each task stage the engine starts `claude -p --input-format stream-json --output-format stream-json --verbose` in the task's git worktree, with the worker prompt, `--max-turns`, `--max-budget-usd` and the model from config (ADR-0005). Owner messages to a running worker are written to its stdin. A task waiting for CI, review or the owner has no process; the next run resumes the session by id.
- **Permissions.** Runs use `--permission-prompt-tool mcp__jarvis__approve`; the engine shows the request in the web chat (Slack later) and returns the owner's verdict.
- **Guard.** The engine refuses to start if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or a cloud-provider switch is set in its environment, and strips them from child environments.

### Consequences
- Good, because no API cost and no research-preview dependency.
- Good, because the admin console renders structured events, not scraped terminals.
- Bad, because there is no live terminal to attach to; "console" is the event stream (raw TTY view is out of scope).
- Bad, because cost figures from the CLI are estimates, so limits are approximate.

### Confirmation
- RULE: The only way the engine calls a model is `ClaudeCliRunner` spawning the `claude` binary; no `@anthropic-ai/*` SDK dependency.
  CHECK: `grep -rn "@anthropic-ai" */package.json` (expect none) + reviewer
- RULE: `ClaudeCliRunner` removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child env, and startup fails if they are set.
  CHECK: unit test `engine/src/infrastructure/claude/env.test.ts`
- RULE: Every run passes `--max-turns`, `--max-budget-usd` and `--model` from config.
  CHECK: unit test on the argument builder
