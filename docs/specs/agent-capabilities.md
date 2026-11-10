# Agent capabilities: see what the agent can use, and add your own skills and subagents

**Status:** draft (2026-11-10) · **Author:** owner + Jarvis · **Decision:** ADR-0025 · **Stage:** any (a page of the web UI)

A "Capabilities" page lists every skill, subagent and MCP server a run can use, from every source, and
lets the owner write, edit and delete his own skills and subagents. They apply to both the dispatcher and
the worker from the next run.

## 1. Why

What a run can do is spread over four places — the built-in plugin in `agent/`, the target repository's
`.claude/`, the owner's connectors, the engine's own MCP server — and the owner has no single view of it.
Adding a skill today means a pull request against Jarvis, so small, personal helpers ("how I like release
notes written") never get written.

## 2. Scope

**Goals**

- One read-only page listing skills, subagents and MCP servers, each with its source.
- Create, edit and delete the owner's own skills and subagents from the UI.
- The owner's items live outside git (`~/.jarvis/plugin`), so a deploy never touches them.
- A mistake is recoverable: a backup before every overwrite and delete.

**Non-goals**

- No editing of built-in or repository items; they change through git and pull requests.
- No adding or editing MCP servers; `~/.jarvis/mcp/servers.json` stays a file the owner edits.
- No way for an agent to write a skill or a subagent, ever (see 4).
- No versions, sharing or import of skills between machines in this iteration.

**Anti-goals**

- A secret on the page, in any form.
- A prompt injection that reaches an agent changing the instructions of later runs.

## 3. Owner decisions (2026-11-10)

1. Stage 1 is the read-only page; stage 2 is the owner's own skills and subagents. MCP is read-only.
2. Owner items are a second plugin directory, `~/.jarvis/plugin`, loaded by every run like `agent/`.
3. Built-in and repository items are read-only. An owner item may not reuse a built-in's name.
4. Owner items are written only through the owner's HTTP API, never through an agent tool.
5. A timestamped backup before each overwrite and delete; the last 20 are kept.

## 4. How it works

| Source | Skills and subagents | MCP servers |
|---|---|---|
| Built-in | `agent/skills/*/SKILL.md`, `agent/agents/*.md` | `jarvis`; `playwright` when `ui.enabled` |
| Yours | `~/.jarvis/plugin/skills/*/SKILL.md`, `agents/*.md` (editable) | — |
| Repo `owner/name` | `.claude/skills`, `.claude/agents` of each cloned repo in `repos.allow` | — |
| Connector | — | `~/.jarvis/mcp/servers.json` |

API (all owner routes, under `/api`):

- `GET /capabilities` → `{ skills, agents, mcpServers }`. A skill or subagent is
  `{ name, description, source: 'builtin'|'owner'|'repo', repo?, model?, tools?, editable }`. An MCP
  server is `{ name, source: 'builtin'|'connector', roles, transport, command?, args?, url?, envVars }`.
- `GET /capabilities/owner/{skills|agents}/:name` → `{ name, description, body, model?, tools?, markdown }`.
- `PUT /capabilities/owner/skills/:name` with `{ description, body }`; `PUT …/agents/:name` with
  `{ description, body, tools?, model? }`. 201 when created, 200 when replaced; the engine writes the
  frontmatter.
- `DELETE /capabilities/owner/{skills|agents}/:name` → 204.

Limits: name `^[a-z0-9][a-z0-9-]{0,63}$`; description 1–1024 characters, one line; body at most 64 KB;
`model` one of `sonnet`, `opus`, `haiku`; `tools` a list of non-empty strings.

## 5. Acceptance criteria

Numbered `CAP-n`.

**The list**

- CAP-1. When the owner opens the page, then skills, subagents and MCP servers are listed in three
  sections, each item with its name, description and a source badge (Built-in, Yours, or Repo
  `owner/name`).
- CAP-2. A subagent shows its model and tools when it declares them; an MCP server shows its roles,
  transport, command or URL and the names of its environment variables.
- CAP-3. If a repository in `repos.allow` is not cloned, then it contributes nothing and no error is shown.
- CAP-4. If `~/.jarvis/plugin` does not exist, then the page lists no owner items and runs get no second
  `--plugin-dir`.
- CAP-5. Built-in and repository items have no Edit or Delete; owner items do.

**Writing**

- CAP-6. When the owner saves a new skill or subagent, then the file is written with `name`,
  `description` (and `tools`, `model` for a subagent) in its frontmatter, `plugin.json` is created if
  missing, and the item appears in the list.
- CAP-7. If a name already exists among the owner's items, then the save replaces it and a backup of the
  previous file exists in `~/.jarvis/plugin-backups`.
- CAP-8. If the name is a built-in skill's (or subagent's), then the save is refused with an error that
  names the built-in, and nothing is written.
- CAP-9. If the name, description, body, model or tools break the limits above, then the request is
  refused with the offending field named, the form shows it inline, and nothing is written.
- CAP-10. When the owner deletes an item (after a confirmation), then a backup is written first and the
  file is removed; the folder of a skill is removed only when empty.
- CAP-11. After 20 backups, the oldest are removed.
- CAP-12. If a run starts after a save, then it is started with `--plugin-dir ~/.jarvis/plugin` after the
  built-in plugin, for the dispatcher, the worker and `ui_check`; a run that was already going is not
  changed.

**Safety**

- CAP-13. No MCP tool of any role, and no `/api/agent` route, can create, change or delete an owner item.
- CAP-14. A worker's permissions deny `Edit` and `Write` under `~/.jarvis/plugin`, also when it does not
  exist yet.
- CAP-15. The MCP listing contains no value: not the value of an `env` entry, not a substituted
  `${VAR}`, not credentials, query or fragment of a URL, not the value after a `--token`-like flag.
- CAP-16. If `servers.json` does not parse, then the page still lists the built-in servers.

## 6. Edge cases

- A name with a slash, `..`, uppercase or a leading dash is refused by the schema before it can be a path.
- A description with a colon, a quote or `#` is stored quoted, so the frontmatter still means what the
  owner typed.
- A body containing `---` on its own line is safe: only the first closing fence ends the frontmatter.
- A repository file without a frontmatter is listed under its file name with an empty description.
- A skill folder holding files the owner added by hand keeps them when the skill is deleted.
- Two saves at once are applied one after the other; the last wins and each leaves its backup.
- An owner skill may share a name with a built-in **subagent** (and the reverse): they are separate
  namespaces.

## 7. Open questions

1. The HTTP API has no login, so a worker with `Bash` could call the PUT route (ADR-0025, known limit). An
   owner credential on the API, or a denied loopback for worker shells, would close it.
2. Should a repository item be shown from the remote's default branch instead of the local clone?
3. Should the owner plugin be exportable (a zip, or a git remote) so it survives a machine change?
