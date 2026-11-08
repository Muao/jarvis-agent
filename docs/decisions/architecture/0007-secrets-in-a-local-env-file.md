---
status: superseded
date: 2026-10-26
decision-makers: []  # owner: ".env at least temporarily" 2026-10-26; drafted by Claude
scope: [".env.example", "engine/src/infrastructure/config/**", "compose.yaml"]
supersedes: []
superseded-by: ["0024"]
---

# ADR-0007: Keep secrets in `~/.jarvis/.env` loaded with Node's `--env-file`, with a path to a secret manager later

## Context and Problem Statement
Jarvis needs a GitHub token for its bot account now and Slack tokens in iteration 2. Everything runs on
the owner's laptop. Secrets must never land in git, logs, artifacts, chat messages or the model's
context. Adding `dotenv` is a dependency we do not need on Node ≥ 22.

## Considered Options
- `~/.jarvis/.env` (outside the repo, ADR-0011) + committed `.env.example`, loaded with `node --env-file=.env`; later optionally wrapped with 1Password CLI (`op run --env-file`) or macOS Keychain
- macOS Keychain from day one via the `security` CLI
- A secret manager service

## Decision Outcome
Chosen option: "`.env` now, secret manager later", because it is the simplest thing a webinar
participant can repeat, and `op run` / Keychain can wrap the same variable names without code changes.

Token inventory:

| Variable | What | Where it comes from | Iteration |
|---|---|---|---|
| — | Claude subscription | `claude` login (`/login`), stored by Claude Code itself; **no** `ANTHROPIC_API_KEY` | 1 |
| `GITHUB_TOKEN` | Fine-grained PAT of the Jarvis bot account, only for the one repo: Contents RW, Pull requests RW, Issues RW (PR comments), Actions R, Commit statuses R, Metadata R | bot account → Settings → Developer settings; bot added as collaborator with Write | 1 |
| `DATABASE_URL`, `POSTGRES_PASSWORD` | Local Postgres in Docker | chosen locally | 1 |
| `NOTION_TOKEN`, Google OAuth credentials | Notion and Google Docs through MCP servers that Jarvis configures itself (owner decision 2026-10-26), listed in `~/.jarvis/mcp/servers.json` with tokens substituted from `.env`; exact servers and scopes chosen in the plan | Notion internal integration; Google Cloud OAuth client | 1 |
| — | Claude Design | handoff link/bundle, no token | 1 |
| `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`, `connections:write`) | Slack app in Socket Mode | api.slack.com/apps | 2 |

Worker processes get only what they need: `GH_TOKEN` for `git push`/`gh pr` in their run; never the
Slack tokens or database URL.

### Consequences
- Good, because zero new dependencies and one obvious place for secrets.
- Bad, because `.env` is plaintext on disk; acceptable for a local PoC, revisit before any shared use.

### Confirmation
- RULE: `.env` and `jarvis.config.json` are in `.gitignore`; only `.env.example` and `jarvis.config.example.json` are committed.
  CHECK: `git check-ignore .env jarvis.config.json`
- RULE: Secrets are read only in `engine/src/infrastructure/config/**`; logs and SSE events redact them.
  CHECK: `grep -rn "process.env" engine/src | grep -v infrastructure/config` (expect none) + unit test on the redactor
- RULE: Child `claude` processes receive an allow-listed env, not `process.env`.
  CHECK: unit test on `ClaudeCliRunner` env builder
