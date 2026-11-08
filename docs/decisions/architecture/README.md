# Architecture Decision Records

Technical decisions that constrain the code. Each record has a `status`, a `scope` (the files it governs)
and `Confirmation` rules that can be checked in review. Change a decision by writing a new record that
supersedes the old one.

Renumbered on 2026-11-08 to close the gaps: superseded records (secrets in `.env`, Infisical wiring, VPS
placement, rehearsal image, telemetry — consolidated into 0015 and 0016) were removed and the rest
compacted to 0001–0018. The former numbering lives in git history; numbers are not reused going forward.

| ADR | Decision | Status | Scope |
|---|---|---|---|
| [0001](0001-typescript-pnpm-monorepo-with-engine-web-shared.md) | Build Jarvis as a TypeScript pnpm monorepo (shared, engine, web) on the Agent Ops Center stack | accepted | ** |
| [0002](0002-onion-architecture-for-engine.md) | Structure the engine as an onion with Zod contracts in shared | accepted | engine/src/**, shared/src/** |
| [0003](0003-run-claude-only-through-the-official-cli-in-print-mode.md) | Run Claude only through the official CLI in print mode with stream-json, on the subscription | accepted | engine/src/infrastructure/claude/**, engine/src/application/** |
| [0004](0004-agent-tools-as-an-engine-mcp-server.md) | Give dispatcher and workers their capabilities as tools of a Jarvis MCP server, incl. the permission prompt tool | accepted | engine/src/presentation/mcp/**, shared/src/mcp.ts |
| [0005](0005-limits-in-a-config-file.md) | Keep limits, models and repo settings in jarvis.config.json, validated with Zod | accepted | jarvis.config*.json, engine/src/infrastructure/config/**, shared/src/config.ts |
| [0006](0006-owner-channel-port-web-chat-then-slack.md) | Talk to the owner through an OwnerChannel port: web chat now, Slack threads (Socket Mode) later | accepted | engine/src/presentation/**, web/src/features/chat/** |
| [0007](0007-github-bot-account-and-polling-watcher.md) | Act on GitHub as a bot account; watch CI and reviews by polling | accepted | engine/src/infrastructure/github/**, engine/src/presentation/watcher/**, engine/src/infrastructure/git/** |
| [0008](0008-state-in-postgres-artifacts-on-disk.md) | Store state and journals in Postgres (Docker), SDD artifacts as files per task | accepted | engine/src/infrastructure/db/**, engine/drizzle/**, compose.yaml |
| [0009](0009-agent-definition-as-plugin-and-jarvis-home.md) | Ship the agent definition as a plugin in agent/; keep personal and runtime data in ~/.jarvis | accepted | agent/**, engine/src/infrastructure/claude/**, engine/src/infrastructure/config/** |
| [0010](0010-react-vite-spa-with-css-modules-and-tanstack-query.md) | Build the web app as a React 19 + Vite SPA with react-router, CSS Modules and TanStack Query fed by SSE | accepted | web/** |
| [0011](0011-test-with-vitest-real-postgres-and-a-fake-claude-binary.md) | Test with Vitest/RTL, real Postgres, Playwright and a fake `claude` binary | accepted | tests, engine/test/**, web/e2e/** |
| [0012](0012-repo-allowlist-with-clone-on-demand.md) | Let Jarvis clone a repo on demand if it is on an allow-list or owned by the owner's GitHub account, instead of one fixed `repo.path` | accepted | shared/src/config.ts, jarvis.config*.json, engine/src/infrastructure/config/**, engine/src/infrastructure/git/**, engine/src/application/** |
| [0013](0013-dispatcher-writable-owner-data.md) | Dispatcher-writable owner data: learned facts appended to USER.md's `## Learned`, and config edits (limits included) on explicit owner request | accepted | agent/USER.example.md, shared/src/{config,mcp}.ts, engine/src/application/{profile,config}/**, engine/src/infrastructure/profile/** |
| [0014](0014-ui-verification-with-playwright-mcp.md) | Verify a UI change in a real browser through Playwright MCP (ui-tester subagent, engine-leased dev server) and put the screenshots inline in the PR via GitHub's `user-attachments` upload | accepted | agent/agents/ui-tester.md, agent/prompts/worker.md, shared/src/config.ts, engine/src/application/ui/**, engine/src/infrastructure/{dev-server,github,artifacts}/**, docker/runtime/Dockerfile |
| [0015](0015-secrets-only-in-infisical.md) | Secrets live only in Infisical; `~/.jarvis/.env` is the local fallback; no committed or deployed file carries a secret value | accepted | .env.example, compose.yaml, scripts/with-secrets.sh, deploy/systemd/**, engine/src/infrastructure/config/** |
| [0016](0016-server-operations.md) | Server operations: Hetzner VPS behind Tailscale (systemd), rehearsed in a local runtime image, observed via journald + CLI OTel + Alloy + Grafana Cloud; session economics in Postgres | accepted | compose.yaml, docker/runtime/**, deploy/**, engine/src/infrastructure/{claude,logging}/**, engine/src/presentation/timers/** |
| [0017](0017-untrusted-external-content-wrapped-and-reported.md) | Externally-authored text enters prompts wrapped as `<untrusted-content>`; an injection attempt is reported to the owner before the agent continues | accepted | engine/src/application/conversation/untrusted.ts, engine/src/application/code-host/**, agent/prompts/worker.md, agent/SOUL.md |
| [0018](0018-ui-check-tasks-for-an-existing-pull-request.md) | Check an existing PR's UI as a `ui_check` task kind: criteria from spec.md/PR body/diff, untrusted head behind an owner permission, PR comment only after approve | accepted | engine/src/domain/task.ts, engine/drizzle/**, engine/src/application/{tasks,ui}/**, shared/src/{config,mcp}.ts, agent/prompts/**, agent/settings/worker.json |
