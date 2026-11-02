---
status: proposed
date: 2026-10-26
decision-makers: []  # drafted by Claude 2026-10-26; awaiting Ivan Lapa
scope: ["agent/**", "engine/src/infrastructure/claude/**", "engine/src/infrastructure/config/**"]
supersedes: []
superseded-by: []
---

# ADR-0011: Ship the agent definition as a Claude Code plugin in `agent/`, and keep personal and runtime data in `~/.jarvis`

## Context and Problem Statement
Jarvis has three kinds of data with different owners: the agent definition (who Jarvis is, prompts,
subagents, skills, templates, permission rules) that should be versioned and shareable with webinar
participants; personal data (owner preferences, config, secrets, connector settings) that must never be
committed; and runtime data (worktrees, SDD artifacts, per-run generated files). Worker runs execute
inside the target repository's worktree, so the agent definition cannot rely on that repo's `.claude/`.
The owner's personal `~/.claude` plugins, skills and hooks must not leak into the agent. Claude Code
resumes a session only from the directory it was started in.

## Considered Options
- Agent definition as a plugin in `agent/` loaded per run with `--plugin-dir`; runs use `--setting-sources project,local`; personal and runtime data in `~/.jarvis` (overridable by `JARVIS_HOME`)
- Copy `.claude/agents` and skills into every worktree
- Pass subagents inline with `--agents` JSON and prompts with flags only

## Decision Outcome
Chosen option: "Plugin in `agent/` + `~/.jarvis` home", because a plugin bundles subagents, skills and
hooks in one folder the CLI loads per session without touching the target repo, the repo stays free of
personal data, and fixed run directories keep `--resume` working.

```
agent/                         (git)  plugin: SOUL.md, USER.example.md, prompts/, agents/, skills/, templates/, settings/
~/.jarvis/                     (private)
  USER.md  jarvis.config.json  .env  mcp/servers.json
  dispatcher/                  fixed cwd of dispatcher runs
  worktrees/<task-id>/         cwd of worker runs
  tasks/<task-id>/             SDD artifacts, screenshots
  runs/<run-id>/               generated mcp.json and settings.json
```

### Consequences
- Good, because participants get the whole agent definition by cloning the repo and copy only `USER.example.md`, the config and `.env` into `~/.jarvis`.
- Good, because the owner's personal Claude Code customisations do not change agent behaviour.
- Bad, because the target repo's own project settings still load in worker runs; Jarvis's `--settings` file must win on permissions.

### Confirmation
- RULE: Every `claude` run passes `--plugin-dir <repo>/agent` and `--setting-sources project,local`.
  CHECK: unit test on the argument builder
- RULE: Dispatcher runs start in `~/.jarvis/dispatcher`; worker runs in `~/.jarvis/worktrees/<task-id>`.
  CHECK: unit test on the argument builder
- RULE: Nothing under `agent/` contains personal data or secrets; `USER.md` exists only in `~/.jarvis`.
  CHECK: reviewer + `git ls-files agent | grep -E "USER.md$"` (expect none)
