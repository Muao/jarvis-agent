---
status: accepted
date: 2026-11-10
decision-makers: ['owner'] # owner: a Capabilities page; owner-written skills and subagents as a second plugin, for every role; MCP read-only; backups; owner-only writes (2026-11-10); drafted by Claude
scope:
  [
    'shared/src/api/capabilities.ts',
    'engine/src/application/capabilities/**',
    'engine/src/application/ports/capabilities.ts',
    'engine/src/infrastructure/capabilities/**',
    'engine/src/infrastructure/claude/{run-args,run-context,run-files,mcp-listing}.ts',
    'engine/src/infrastructure/config/jarvis-home.ts',
    'engine/src/presentation/http/routes/capabilities.ts',
    'web/src/features/capabilities/**',
  ]
supersedes: []
superseded-by: []
---

# ADR-0025: The owner's own skills and subagents are a second plugin in `~/.jarvis/plugin`, written only through the owner's HTTP API

Extends ADR-0009: the agent definition is the plugin in `agent/`; this adds a second plugin that the
owner, not git, maintains.

## Context and Problem Statement

What the agent can use comes from four places and nothing shows them together: skills and subagents in
`agent/` (the built-in plugin), `.claude/agents` and `.claude/skills` of the target repository (read by
`--setting-sources project,local`), and MCP servers (the engine's own, Playwright, and the connectors in
`~/.jarvis/mcp/servers.json`). The owner cannot see what a run has, and cannot add a skill or a subagent
without a pull request against Jarvis itself.

The owner wants a read-only page that lists all of it, and a way to write his own skills and subagents in
the UI. The second part creates a new risk: skills and subagents are the agent's instructions. Whoever can
write one steers every later run.

## Decision Drivers

- The owner's items must not live in the git checkout: a deploy (`git pull`, a clean checkout, a new
  container) must never overwrite or delete them.
- They must work for the dispatcher and for the worker, exactly like the built-in plugin.
- A prompt injection that reaches an agent (a PR comment, an issue, a web page) must not be able to rewrite
  the agent's instructions for the next run.
- A mistake in the editor must be undoable.
- No new dependency.

## Considered Options

- **A second plugin directory, `~/.jarvis/plugin`, passed as one more `--plugin-dir`.** Claude Code supports
  repeating the flag.
- Write into `agent/` and commit. Rejected: the owner's items would travel through git and PRs, and a deploy
  would be a merge problem.
- Write into the target repository's `.claude/`. Rejected: it is the repository's, it differs per task, and
  `ui_check` runs do not read it (ADR-0018).
- Write into `~/.claude` (user scope). Rejected: ADR-0009 keeps the personal `~/.claude` out of runs on
  purpose.
- Let the dispatcher author skills ("remember how to do X" as a skill) through an MCP tool. Rejected below.

## Decision Outcome

Chosen: **the second plugin**, with writes only through the owner's HTTP API.

### The plugin

`~/.jarvis/plugin/` is a Claude Code plugin named `jarvis-owner`:

```
~/.jarvis/plugin/.claude-plugin/plugin.json
~/.jarvis/plugin/skills/<name>/SKILL.md
~/.jarvis/plugin/agents/<name>.md
```

The engine creates `plugin.json` on the first write. `buildRunArgs` adds `--plugin-dir ~/.jarvis/plugin`
after the built-in one, for every role and every task kind, **only if** `.claude-plugin/plugin.json`
exists. The composition root checks that when it builds the run's context, so a change applies from the
next run (a running session keeps what it started with). `ui_check` runs get it too: it is not a repository
setting, so ADR-0018's reason for `--setting-sources user` does not apply.

### Who may write: the owner, over HTTP, nothing else

`PUT` and `DELETE /api/capabilities/owner/{skills|agents}/:name` are owner routes for the web UI, like
every other route that is not under `/api/agent`. There is **no MCP tool**, in any role, that reads or
writes the owner plugin, and nothing under `/api/agent/...` reaches the use cases. This is the same
boundary as `FORBIDDEN_PATHS` in `update-config.ts` (ADR-0013), which keeps `ui.env` and
`allowlist.githubReviewers` out of chat: a setting that decides what the agent may do is not something the
agent can be talked into changing. A skill is stronger than a setting — it is text the model is told to
follow.

Defence in depth: the engine adds `Edit(//…/plugin/**)` and `Write(//…/plugin/**)` to the worker's deny
list, even before the plugin exists (so a worker cannot create it), and the dispatcher already denies
`Edit`, `Write` and `Bash`.

Known limit: the HTTP API is loopback-only and has no login, as the rest of the owner API. A worker has
`Bash`, so a worker that is told to `curl -X PUT http://127.0.0.1:4310/api/capabilities/owner/...` is not
stopped by the permission layer. Closing this needs an owner credential on the HTTP API (or a denied
loopback for worker shells), which is its own decision and also covers `PUT /api/config`. Until then this
record limits the exposure to a path that needs an injected instruction to go through `Bash`, and the
backups below make the result recoverable.

### Name collisions

A skill or subagent in the owner plugin may not have the name of a built-in one of the same kind; the API
refuses with a 400 `invalid_input` naming the built-in. Two plugins defining the same name leave it to
Claude Code to pick one, and the prompts in `agent/prompts/` call subagents and skills by bare name
(`reviewer`, `sdd-flow`); an owner item shadowing one of those would change the behaviour of a task while
looking like an addition. Built-ins change through git and review, so the owner's items yield. Skills and
subagents are separate namespaces. A repository may define the same name as the owner (it is a different
source, and the page shows the source); collisions with repository items are not checked, because the set
changes with every clone.

### Validation

Names match `^[a-z0-9][a-z0-9-]{0,63}$`: they become a path segment, so nothing else can reach the file
system. Description: non-empty, one line, at most 1024 characters. Body: at most 64 KB of UTF-8. Subagent
`model`: one of `sonnet`, `opus`, `haiku`. `tools`: a list of non-empty strings without commas or line
breaks. The schemas live in `shared/src/api/capabilities.ts`; the use case parses again, so the store never
sees unvalidated input.

The engine writes the frontmatter itself (`name`, `description`, `tools`, `model`); the owner supplies the
body only. A small strict reader and writer for `key: value` lines lives in
`infrastructure/capabilities/frontmatter.ts` — no YAML dependency. It writes the description as a JSON
string (a valid double-quoted YAML scalar) so a colon or a quote in it cannot change what the line means,
and it reads the shapes other files use (quotes, `>` blocks, `[a, b]`, `- a`) so that repository items list
correctly.

### Backups

Before every overwrite and every delete the engine copies the file to
`~/.jarvis/plugin-backups/<timestamp>-<n>.<kind>.<name>.md` and keeps the last 20 across all items (the
pattern of the memory backups in `file-profile-store.ts`). Writes go through one queue and replace the
file by renaming a temporary one over it. Restoring is a copy by hand.

### MCP servers are read-only

The page lists them; it does not edit them. A connector entry carries a command, arguments and a place
for secrets, and `servers.json` is where the owner decided to keep them (ADR-0009, ADR-0015); a form that
writes it would put credentials near a web surface and would need a restart story. They stay a file the
owner edits.

The listing **never shows a secret**. It is built by the same module as `mcp.json`
(`run-files.ts`: `jarvisServer`, `playwrightServer`, `readRawConnectors`), so no knowledge of the built-ins
is duplicated, but it reads `servers.json` **without substituting** `${VAR}`. It returns the command, the
arguments (with the value after a flag that looks like a secret masked), the URL without credentials,
query and fragment, and the **names** of the environment variables (keys of `env` and any `${VAR}` the
entry refers to) — never a value, never a substituted value. The response schema has no field that could
hold one.

### What the Capabilities view reads, per source

| Source | Skills and subagents | MCP servers |
|---|---|---|
| Built-in (`builtin`) | `agent/skills/*/SKILL.md`, `agent/agents/*.md` | `jarvis` (every role), `playwright` (workers, when `ui.enabled`) |
| Owner (`owner`) | `~/.jarvis/plugin/skills/*/SKILL.md`, `agents/*.md`; editable | — |
| Repository (`repo`) | `.claude/skills/*/SKILL.md`, `.claude/agents/*.md` of each repo in `repos.allow` that is cloned in `~/.jarvis/repos/<owner>/<name>`; a repo that is not cloned is skipped silently | — |
| Connector (`connector`) | — | `~/.jarvis/mcp/servers.json`, for worker runs |

Repository items are read-only: they change through that repository's pull requests.

### Consequences

- Good: the owner sees what a run can use, and can extend it without a pull request and without a deploy
  touching it.
- Good: the owner's items follow the same loading path as the built-in plugin, so dispatcher and worker
  need no new mechanism.
- Bad: the owner plugin is unreviewed text that every run follows. The API is the only writer, and
  backups are the undo; there is no review step.
- Bad: the loopback API has no login (see the known limit).
- Bad: a repository's own `.claude/` is listed from the local clone, which may be behind its remote.

## Confirmation

- RULE: no tool in `toolsByRole` and no `/api/agent` route reads or writes the owner plugin; the MCP server
  sources do not reference it.
  CHECK: `engine/src/presentation/http/capabilities.test.ts` ("no agent tool can write the owner plugin")
- RULE: a worker may not edit or write under the owner plugin directory, even before it exists.
  CHECK: `run-files.test.ts`
- RULE: every role's run gets `--plugin-dir <owner plugin>` after the built-in one, and only when the
  plugin has a manifest.
  CHECK: `run-args.test.ts`
- RULE: an owner item may not take a built-in's name; names, description, body, model and tools are
  validated.
  CHECK: `shared/src/api/capabilities.test.ts`; the HTTP tests
- RULE: an overwrite and a delete leave a backup, and only the last 20 are kept.
  CHECK: `file-owner-plugin-store.test.ts`
- RULE: the MCP listing contains no value of an environment variable, literal or substituted.
  CHECK: `mcp-listing.test.ts`
