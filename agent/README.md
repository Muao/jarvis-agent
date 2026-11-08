# Agent definition

The Claude Code plugin that defines who Jarvis is and how it works (ADR-0011). It contains no personal data:
`USER.md` lives only in `~/.jarvis` and is never committed.

| Path                         | Purpose                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json` | Plugin manifest (`jarvis`)                                                                |
| `SOUL.md`                    | Role, principles and style, shared by both roles                                          |
| `USER.example.md`            | Template of owner preferences; copy to `~/.jarvis/USER.md`                                |
| `prompts/dispatcher.md`      | Dispatcher role: understands messages, manages tasks, replies. No code                    |
| `prompts/worker.md`          | Worker role: the SDD loop from context to draft PR and fix rounds                         |
| `agents/`                    | Subagents of the worker: `context-researcher`, `plan-verifier`, `implementer`, `reviewer` |
| `skills/sdd-flow/`           | Artifact contract for `context.md`, `spec.md`, `plan.md`, `tasks.md`, `result.md`         |
| `templates/`                 | Starting points for the five artifacts                                                    |
| `settings/worker.json`       | Base permission rules for worker runs                                                     |

## How the engine loads it

Every run passes (see `engine/src/infrastructure/claude`):

- `--plugin-dir <repo>/agent` - loads subagents and the skill, namespaced under `jarvis`
- `--setting-sources project,local` - the owner's personal `~/.claude` does not leak in
- `--append-system-prompt-file` - a role prompt: `SOUL.md` followed by `prompts/<role>.md`. The CLI takes one
  file, so the engine writes the concatenation to the run directory and passes that path
- `--settings <runDir>/settings.json` - `settings/worker.json` merged with `autoAllowedCommands` from the config
  (appended to `permissions.allow`) and engine-generated denies for the configured base branch
- `--mcp-config <runDir>/mcp.json --strict-mcp-config` - the Jarvis MCP server (tools appear as `mcp__jarvis__<tool>`)

The first user message of a run is built by the engine: a `## Run context` block (`taskId`, `branch`,
`artifactsDir`, `stage`), the `## Owner preferences (USER.md)` section, any `## Pending owner messages`, then the
task or owner message. Dispatcher runs get the preferences and the message only. `USER.md` is not in the system
prompt because the CLI fixes the system prompt for the life of a session; the first user message is re-sent on
each run, so profile edits apply from the next run.

The `deny` rules in `settings/worker.json` implement SEC-01 and SEC-02 and must stay: deny wins over allow.

## Connectors (`~/.jarvis/mcp/servers.json`)

Connector MCP servers are not part of the plugin; the owner lists them in `~/.jarvis/mcp/servers.json`, and the
engine substitutes `${VAR}` from its environment into each run's `mcp.json`. Google Docs (decision and setup:
`docs/architecture/connectors.md`):

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["-y", "@piotr-agier/google-drive-mcp@2.13.0"],
      "env": {
        "GOOGLE_DRIVE_MCP_REFRESH_TOKEN": "${GOOGLE_DRIVE_MCP_REFRESH_TOKEN}",
        "GOOGLE_DRIVE_MCP_CLIENT_ID": "${GOOGLE_DRIVE_MCP_CLIENT_ID}",
        "GOOGLE_DRIVE_MCP_CLIENT_SECRET": "${GOOGLE_DRIVE_MCP_CLIENT_SECRET}"
      }
    }
  }
}
```

The version is pinned on purpose. `GOOGLE_DRIVE_MCP_SCOPES` is deliberately absent: in this mode it does nothing,
the token's rights are fixed when it is authorised.
