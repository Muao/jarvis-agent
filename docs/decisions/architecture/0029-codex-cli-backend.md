---
status: accepted
date: 2026-11-12
decision-makers: []
scope: ["engine/src/**", "shared/src/config.ts"]
supersedes: []
superseded-by: []
---

# ADR-0029: Support the Codex CLI as a Jarvis backend

## Context and Problem Statement

ADR-0003 selects Claude Code as the sole model runner. The owner wants to run
Jarvis on macOS with the official Codex CLI authenticated through ChatGPT.
The two CLIs use different process protocols, tool configuration, and approval
mechanisms. The existing binary path setting only selects a Claude executable.

## Decision

Add an explicit backend setting and a Codex implementation of the existing
`AgentRunner` port. Keep Claude as the default for existing installations.
This decision overrides ADR-0003's sole-runner rule for the Codex backend.
ADR-0003 continues to govern Claude runs.
Select the startup login check and connection probe by backend. Use Codex
through its official CLI and require ChatGPT authentication for the Codex backend.
Keep provider session IDs and model settings scoped to their backend.

Evaluate the Codex app-server protocol for structured events, session resume,
live owner input, and approvals. The adapter must map these capabilities to
Jarvis's existing run lifecycle and enforce role and worktree boundaries.
Verify how to supply run-scoped Jarvis MCP tools and credentials without exposing
the engine's secrets to model-driven commands. Reject unsupported task kinds or
configurations explicitly until equivalent controls are available.

## Acceptance Criteria

- A local engine configured for Codex starts with a ChatGPT login and no Claude
  installation or OpenAI API key.
- A local chat turn can use the Jarvis MCP tools and resume its Codex session.
- A worker runs in its task worktree, reports events, and can be stopped.
- Owner input, approvals, and execution limits are either supported and tested
  or surfaced as unavailable before starting an affected workflow.
- Existing Claude configurations and sessions continue to work.

## Amendment: Codex browser capability (T-6, 2026-11-12)

Codex build workers expose start_dev_server, stop_dev_server, ui_browser and report_ui_check through the existing authenticated engine API. Browser results preserve image content alongside text/evidence. Worker runs start fresh Codex threads so old dynamic tool catalogs cannot hide newly available capabilities; dispatcher thread resume is unchanged. Pending dynamic calls settle before run-exit cleanup. Standalone ui_check tasks remain unsupported on Codex.
