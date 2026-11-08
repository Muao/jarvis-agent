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

The units run `pnpm` and `node` from systemd's default PATH (`/usr/bin:/bin`, plus `/usr/local/bin`). Install Node
system-wide (NodeSource, `corepack enable` into `/usr/bin` or `/usr/local/bin`); an nvm install is not on that PATH.
We document this rather than hard-code `Environment=PATH=`, because the right directories depend on how Node was installed.

```sh
sudo cp deploy/systemd/jarvis-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-engine jarvis-web
tailscale serve --bg 5180
```

`/etc/jarvis/infisical.env` (`INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`) must exist
first (deployment.md §3), owned `root:root`, mode `0600` (systemd reads it as root; `jarvis` and a child `claude` must not). `JARVIS_ENV` selects the Infisical environment (default `prod`).

## Rebuild after losing the server

1. Restore the Hetzner snapshot (it holds Postgres, `~/.jarvis` and `~/.claude`).
2. `claude -p "ping"` as `jarvis` must answer.
3. If it does not, log in again: `claude`, then `/login`.
4. `systemctl status jarvis-engine jarvis-web`
5. `curl -fsS http://127.0.0.1:4310/api/health`

## Update

The sequence is in [`deployment.md` §5](../docs/architecture/deployment.md#5-update); it is kept in one place only.

## Notes

- `After=docker.service` does not mean Postgres accepts connections; `Restart=on-failure` covers that gap.
- `with-secrets.sh` passes no `--domain`, so it assumes Infisical Cloud US.

## Residual risk

A child `claude` runs as `jarvis`, the same user as the engine, so it can read `/proc/<engine-pid>/environ` and every
secret `infisical run` injected, including the short-lived `INFISICAL_TOKEN`. The allow-list in `child-env.ts` limits
what a child inherits; it cannot stop a same-uid process reading a sibling's environment. Accepted for now on a
single-owner box. The real fix is a separate uid for child `claude` processes (a task of its own: ADR-0007, worktree
permissions, `~/.claude`).

## Not verified yet

Nothing here has been executed on a server:

- the Infisical branch of `scripts/with-secrets.sh` (the CLI is not installed locally and no project exists yet);
- the systemd units (never loaded by systemd);
- the `ExecStartPost` health curl (`/api/health` lands in a later task).

Smoke test on the server. It prints names and counts, never values. The env file is `0600 root`, so check it as root:

```sh
sudo sh -c 'for v in INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET INFISICAL_PROJECT_ID; do grep -q "^$v=." /etc/jarvis/infisical.env && echo "$v set" || echo "$v MISSING"; done'
```

Then, as `jarvis`, load the file through systemd's view of it (for example `sudo systemd-run --uid=jarvis -p EnvironmentFile=/etc/jarvis/infisical.env -P /home/jarvis/jarvis/scripts/with-secrets.sh sh -c 'env | cut -d= -f1 | grep -c "^GITHUB_TOKEN$"'`; `1` means injected), and finally:

```sh
sudo systemctl status jarvis-engine --no-pager | head -5
```
