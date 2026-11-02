# Architecture Decision Records

Technical decisions that constrain the code. Each record has a `status`, a `scope` (the files it governs)
and `Confirmation` rules that can be checked in review. Change a decision by writing a new record that
supersedes the old one.

| ADR | Decision | Status | Scope |
|---|---|---|---|
| [0002](0002-typescript-pnpm-monorepo-with-engine-web-shared.md) | Build Jarvis as a TypeScript pnpm monorepo (shared, engine, web) on the Agent Ops Center stack | proposed | ** |
| [0003](0003-onion-architecture-for-engine.md) | Structure the engine as an onion with Zod contracts in shared | proposed | engine/src/**, shared/src/** |
| [0004](0004-run-claude-only-through-the-official-cli-in-print-mode.md) | Run Claude only through the official CLI in print mode with stream-json, on the subscription | proposed | engine/src/infrastructure/claude/**, engine/src/application/** |
| [0005](0005-agent-tools-as-an-engine-mcp-server.md) | Give dispatcher and workers their capabilities as tools of a Jarvis MCP server, incl. the permission prompt tool | proposed | engine/src/presentation/mcp/**, shared/src/mcp.ts |
| [0006](0006-limits-in-a-config-file.md) | Keep limits, models and repo settings in jarvis.config.json, validated with Zod | proposed | jarvis.config*.json, engine/src/infrastructure/config/**, shared/src/config.ts |
| [0007](0007-secrets-in-a-local-env-file.md) | Keep secrets in ~/.jarvis/.env loaded with Node --env-file | proposed | .env.example, engine/src/infrastructure/config/**, compose.yaml |
| [0008](0008-owner-channel-port-web-chat-then-slack.md) | Talk to the owner through an OwnerChannel port: web chat now, Slack threads (Socket Mode) later | proposed | engine/src/presentation/**, web/src/features/chat/** |
| [0009](0009-github-bot-account-and-polling-watcher.md) | Act on GitHub as a bot account; watch CI and reviews by polling | proposed | engine/src/infrastructure/github/**, engine/src/presentation/watcher/**, engine/src/infrastructure/git/** |
| [0010](0010-state-in-postgres-artifacts-on-disk.md) | Store state and journals in Postgres (Docker), SDD artifacts as files per task | proposed | engine/src/infrastructure/db/**, engine/drizzle/**, compose.yaml |
| [0011](0011-agent-definition-as-plugin-and-jarvis-home.md) | Ship the agent definition as a plugin in agent/; keep personal and runtime data in ~/.jarvis | proposed | agent/**, engine/src/infrastructure/claude/**, engine/src/infrastructure/config/** |
| [0012](0012-react-vite-spa-with-css-modules-and-tanstack-query.md) | Build the web app as a React 19 + Vite SPA with react-router, CSS Modules and TanStack Query fed by SSE | proposed | web/** |
| [0013](0013-test-with-vitest-real-postgres-and-a-fake-claude-binary.md) | Test with Vitest/RTL, real Postgres, Playwright and a fake `claude` binary | proposed | tests, engine/test/**, web/e2e/** |
| [0015](0015-run-on-a-hetzner-vps-reached-over-tailscale.md) | Run Jarvis on a Hetzner VPS as systemd services, reached only over Tailscale | proposed | compose.yaml, web/vite.config.ts, docs/architecture/deployment.md |
| [0016](0016-secrets-in-infisical-injected-with-infisical-run.md) | Keep secrets in Infisical, inject with infisical run; ~/.jarvis/.env stays the local fallback | proposed | .env.example, engine/package.json, docs/architecture/deployment.md |
