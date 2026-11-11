---
status: accepted
date: 2026-11-11
decision-makers: ['Ivan Lapa'] # owner: use my claude.ai login for Notion, Slack, Google Docs and Drive instead of a token per service; read-only; dispatcher and worker (2026-11-11); drafted by Claude
scope:
  [
    'shared/src/config.ts',
    'engine/src/infrastructure/claude/{claude-ai-connectors,run-args,run-files,run-context,mcp-listing}.ts',
    'engine/src/infrastructure/connections/create-connection-checks.ts',
    'agent/prompts/{worker,dispatcher}.md',
    'docs/architecture/connectors.md',
  ]
supersedes: []
superseded-by: []
---

# ADR-0027: Runs may read the owner's claude.ai connectors, listed one by one in the config and allowed tool by tool

Amends `docs/architecture/connectors.md`, which said remote MCP with OAuth through Claude Code is not
used on the server, and the "every run is strict" reading of ADR-0003.

## Context and Problem Statement

A connector needed a credential per service in Infisical and a server entry in
`~/.jarvis/mcp/servers.json`. For Notion nobody had chosen the MCP server; for Google Docs the setup
is an OAuth client, a consent screen and a refresh token copied by hand; Slack had no path at all.
Meanwhile the `claude` login on the server is the owner's claude.ai account, and that account already
has Notion, Slack, Google Docs and Google Drive connected. The owner asked to use that login.

Measured on the server with Claude Code 2.1.319 (2026-11-11), in print mode:

- The account's connectors load only when the run has **no** `--strict-mcp-config` **and** the
  `user` settings source. With `--setting-sources project,local`, or with strict mode, none load.
- Without strict mode every connector of the account loads, not a chosen few: ten servers, about 200
  tools, Gmail and Calendar among them.
- A `deny` rule in `--settings` or `--disallowedTools` removes a tool from the run, by full name or
  by server (`mcp__claude_ai_Gmail`). An `allowedMcpServers` list in `--settings` removed every
  connector, the wanted ones too, so it is not the mechanism.
- With the rules of this ADR a run saw 17 Notion, 13 Slack, 1 Google Docs and 8 Google Drive tools,
  read from Notion and Slack, and was asked for no permission.

## Considered Options

- Keep a token per service (status quo), and choose a Notion MCP server.
- Authorise each remote MCP server on the server with `/mcp` and name it in `servers.json`.
- **Let runs use the account's connectors: listed in the config, read tools allowed by name,
  everything else denied.**

## Decision Outcome

Chosen option: the account's connectors, because the owner is already logged in to all four and a
token per service buys nothing the owner wants. `servers.json` stays for everything that is not an
account connector.

- **`connectors.claudeAi`** in `jarvis.config.json` lists what runs may read: any of `notion`,
  `slack`, `google_docs`, `google_drive`. Empty is the default and changes nothing: every run stays
  strict.
- **A non-empty list changes two flags** of a dispatcher or worker run: `--strict-mcp-config` is
  dropped and `--setting-sources` becomes `user,project,local`. The run's own servers still come from
  its `mcp.json`.
- **Reading is allowed by name.** `claude-ai-connectors.ts` holds, per connector, the tools that read
  and every other tool it had on 2026-11-11. The first list goes into the run's `allow` rules; the
  second, and every unlisted connector as a whole server, into `deny`. Nothing is allowed by pattern.
- **A `ui_check` run gets none of it.** It stands in someone else's pull request (ADR-0018) and stays
  strict.
- **What a connector returns is untrusted content** (ADR-0017). The engine cannot wrap it; SOUL
  principle 4 and the role prompts carry the rule.

### Consequences

- Good, because a connector is one word in the config and no secret to store, rotate or leak.
- Good, because a run cannot write to Notion, Slack or Drive whatever a page tells it: the tools are
  not in the run.
- Bad, because a read tool reaches the owner's **whole** account in that service, private Slack
  channels and direct messages included. `connectors.notionRoot` and `connectors.googleFolder` are
  now guidance to the agent, not a boundary. A prompt injection can make a run read more than the
  task needs; it still cannot send what it read anywhere but the task's own artifacts and pull
  request.
- Bad, because a tool the connector adds later is in neither list: it is in the run, and calling it
  raises a permission card. The owner decides, but the lists need a refresh to hide it.
- Bad, because the `user` settings source also loads what else the account and `~/.claude` carry: on
  the server, seven account plugins and 56 more skills than a strict run sees, and any MCP server the
  owner added with `claude mcp add`. Their tools are not allowed, so they ask; their skills cost
  context. Keep `~/.claude` on the server bare.
- Bad, because the connector's token lives with the `claude` login, not in Infisical. When the login
  or a connector's grant expires, a run finds the tool missing and reports the source unavailable
  (CTX-05); the owner reconnects it on claude.ai or with `claude` → `/login`.
- Bad, because connectors connect while the run starts. One probe in six saw Slack still `pending`
  when the run began; whether a tool that arrives late is usable in print mode was not measured.

### Confirmation

- RULE: No tool in a connector's `read` list changes, sends or creates anything, and no tool is in
  both lists.
  CHECK: `engine/src/infrastructure/claude/claude-ai-connectors.test.ts`
- RULE: A run without listed connectors, and every `ui_check` run, has `--strict-mcp-config`.
  CHECK: `engine/src/infrastructure/claude/claude-ai-connectors.test.ts`, `run-args.test.ts`
- RULE: A run with listed connectors denies the other tools of each and every unlisted connector.
  CHECK: `engine/src/infrastructure/claude/claude-ai-connectors.test.ts`, `run-files.test.ts`
