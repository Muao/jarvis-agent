# Deploy files

Files for the Hetzner VPS (ADR-0015) with secrets from Infisical (ADR-0016). The full setup is in
[`docs/architecture/deployment.md`](../docs/architecture/deployment.md).

| File                            | Purpose                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `systemd/jarvis-engine.service` | Engine under `scripts/with-secrets.sh`; start fails if `/api/health` fails                             |
| `systemd/jarvis-web.service`    | `vite preview` on `127.0.0.1:5180`, proxying `/api` to the engine                                      |
| `../scripts/with-secrets.sh`    | Logs in with the machine identity and runs `infisical run`; plain `exec` without `INFISICAL_CLIENT_ID` |

The engine unit's `ExecStartPost` calls `GET /api/health`, so the engine must be at a commit that has that route.

## Install

```sh
sudo cp deploy/systemd/jarvis-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-engine jarvis-web
tailscale serve --bg 5180
```

`/etc/jarvis/infisical.env` (`INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`) must exist
first (deployment.md §3). `JARVIS_ENV` selects the Infisical environment (default `prod`).

## Rebuild after losing the server

1. Restore the Hetzner snapshot (it holds Postgres, `~/.jarvis` and `~/.claude`).
2. `claude -p "ping"` as `jarvis` must answer.
3. If it does not, log in again: `claude`, then `/login`.
4. `systemctl status jarvis-engine jarvis-web`
5. `curl -fsS http://127.0.0.1:4310/api/health`

## Update

```sh
cd ~/jarvis && git pull && pnpm install --frozen-lockfile && pnpm --filter @jarvis/web build \
  && scripts/with-secrets.sh pnpm --filter @jarvis/engine db:migrate \
  && sudo systemctl restart jarvis-engine jarvis-web
```
