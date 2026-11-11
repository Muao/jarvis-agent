---
status: accepted
date: 2026-11-08
decision-makers: ["owner"]  # owner: "secrets only in Infisical; env only as the local fallback; a real Postgres password, stored in Infisical" (2026-11-08); drafted by Claude
scope: [".env.example", "compose.yaml", "scripts/with-secrets.sh", "deploy/systemd/**", "engine/src/infrastructure/config/**", "docs/architecture/deployment.md"]
supersedes: []  # consolidates the former 0007 and 0016 (pre-renumbering; see git history)
superseded-by: []
---

# ADR-0015: Secrets live only in Infisical; `~/.jarvis/.env` is the local fallback; no committed or deployed file carries a secret value

## Context and Problem Statement

The former record 0007 put secrets in a plaintext `~/.jarvis/.env` "temporarily"; the former 0016
added Infisical so the laptop and the VPS read one source (both are consolidated here; their full
option analyses live in git history). Two gaps remained. First, `compose.yaml` shipped a literal Postgres
password (`jarvis`/`jarvis`) — the security audit (2026-11-08) rated it High, because any process on the
host can connect to the published `127.0.0.1:5433` and rewrite Jarvis's state, permission decisions
included. Second, `.env` was still a hand-maintained second source of truth that drifts from Infisical.
This record replaces both earlier ones with one rule set.

## Decision Outcome

**Infisical is the single source of truth for secrets. `~/.jarvis/.env` exists only as the local
fallback, ideally exported from Infisical, never as an independent store. No committed or deployed file
carries a secret value — compose and systemd reference variables, never literals.**

- **Infisical.** Project `jarvis`, environments `dev` (laptop) and `prod` (VPS); variable names exactly
  as in `.env.example`. Laptop: `infisical login` (owner's account), run through
  `scripts/with-secrets.sh`. Server: a machine identity with Universal Auth, read-only on `prod`; its
  client id and secret are the only secrets on disk — `/etc/jarvis/infisical.env`, `root:root`, mode
  `0600` — loaded by the systemd units, which run everything through `with-secrets.sh`. Rotation:
  change the value in Infisical, `systemctl restart jarvis-engine`.
- **Fallback.** Without `INFISICAL_CLIENT_ID` the engine reads `~/.jarvis/.env`
  (`--env-file-if-exists`); webinar participants keep this path. Regenerate the file from Infisical
  (`infisical export --env=dev > ~/.jarvis/.env`) rather than editing it by hand; a hand edit is the
  exception, and Infisical wins on conflict.
- **No literals in config.** `compose.yaml` takes `POSTGRES_PASSWORD` (and the `DATABASE_URL` built
  from it) from the environment with `${…:?}` — it refuses to start without a value instead of falling
  back to a default. Compose is run as `scripts/with-secrets.sh docker compose …` or with
  `docker compose --env-file ~/.jarvis/.env …`. The systemd units carry no secret values either
  (ADR-0016).
- **Postgres has a real password.** Generated (`openssl rand -base64 24`), stored in Infisical as
  `POSTGRES_PASSWORD` and inside `DATABASE_URL`/`DATABASE_URL_TEST`. Changing it on an existing volume
  is `ALTER USER jarvis PASSWORD '…'` (runbook in `docs/architecture/deployment.md`), not a volume
  rebuild.
- **Token inventory** (unchanged from the former 0007): the Claude subscription is the `claude` login, never
  an `ANTHROPIC_API_KEY`; `GITHUB_TOKEN` is the bot's fine-grained PAT scoped to the allowed repos;
  `NOTION_TOKEN` and the Google Drive OAuth triplet feed the connector MCP servers; `POSTGRES_PASSWORD`
  / `DATABASE_URL` / `DATABASE_URL_TEST` for the database; `HEARTBEAT_URL` and
  `OTEL_EXPORTER_OTLP_HEADERS` for observability (ADR-0016); `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` in
  iteration 2.
- **Child processes** keep the long-standing guarantees: secrets are read only in
  `engine/src/infrastructure/config/**`, redacted in logs, and children receive an allow-listed
  environment, never `process.env` — a worker gets `GH_TOKEN`, never the database URL or Slack tokens.

## Consequences

- Good, because one source feeds the laptop, the container rehearsal and the server, and a leaked
  compose file or systemd unit discloses nothing.
- Good, because the Postgres port on `127.0.0.1:5433` no longer accepts a guessable default password.
- Bad, because `docker compose up -d` alone no longer works: it needs `with-secrets.sh` or
  `--env-file ~/.jarvis/.env`. README and deployment docs carry the exact commands.
- Bad, because if Infisical is down at start-up the engine does not start (running processes are
  unaffected); the local fallback keeps the laptop workflow alive.
- Known limit (accepted, unchanged from the former 0016): a child `claude` runs as the same uid as the engine
  and can read `/proc/<engine-pid>/environ`; a separate uid for children is the real fix.

## Confirmation

- RULE: No secret values in the repo; `.env.example` lists names only, and no committed file carries a
  literal credential.
  CHECK: `git grep -nE "(gh[p]_|github[_]pat_|xox[bp]-|secret[_])"` and
  `git grep -nE "postgres://jarvis:jarvis@|POSTGRES_PASSWORD: *jarvis"` (expect none)
- RULE: `compose.yaml` fails fast without `POSTGRES_PASSWORD` instead of defaulting.
  CHECK: `docker compose config` without the variable exits non-zero naming it
- RULE: On the server the only secret file is `/etc/jarvis/infisical.env`, `root:root`, mode `0600`;
  there is no `~/.jarvis/.env`.
  CHECK: `test "$(stat -c '%a %U:%G' /etc/jarvis/infisical.env)" = '600 root:root' && test ! -e ~jarvis/.jarvis/.env`
- RULE: Secrets are read only in `engine/src/infrastructure/config/**`; child `claude` processes
  receive an allow-listed env.
  CHECK: `grep -rn "process.env" engine/src | grep -v infrastructure/config` (expect only `main.ts`) +
  `engine/src/infrastructure/claude/env.test.ts`
