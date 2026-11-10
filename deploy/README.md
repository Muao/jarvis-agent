# Deploy files

Files for the Hetzner VPS (ADR-0016) with secrets from Infisical (ADR-0015). The full setup is in
[`docs/architecture/deployment.md`](../docs/architecture/deployment.md).

| File                            | Purpose                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `systemd/jarvis-engine.service` | Engine under `scripts/with-secrets.sh`; start fails if `/api/health` fails                             |
| `systemd/jarvis-web.service`    | `vite preview` on `127.0.0.1:5180`, proxying `/api` to the engine                                      |
| `../scripts/with-secrets.sh`    | Logs in with the machine identity and runs `infisical run`; plain `exec` without `INFISICAL_CLIENT_ID` |

The engine unit's `ExecStartPost` runs `scripts/wait-healthy.sh`, which polls `GET /api/health` for up to 60 s and
accepts 200 or 503 (alive, database down).

The Claude Code installer puts `claude` in `~/.local/bin`, which is not on systemd's PATH. Link it once, as root:
`ln -sf /home/jarvis/.local/bin/claude /usr/local/bin/claude`. Do not set `engine.claudeBinary` to an absolute
path instead: the engine checks the subscription login only when that value is exactly `claude`.

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

## Deploy script

`pnpm run deploy:remote` (from the laptop: `ssh root@jarvis-01 …/scripts/deploy.sh`), or `pnpm run deploy` as
`jarvis` on the server once it has a sudo rule, runs [`../scripts/deploy.sh`](../scripts/deploy.sh): fast-forward
`git pull`, `pnpm install --frozen-lockfile`, build web, run migrations through `with-secrets.sh`, then restart
`jarvis-engine` and (once that unit exists) `jarvis-web`. A `flock` stops two deploys overlapping. Run as root, the script does every git and pnpm step as `jarvis`. See
[`.claude/skills/deployment/SKILL.md`](../.claude/skills/deployment/SKILL.md) for the practices behind that order
and what to add if this ever grows past one script and one box.

Always run it as `pnpm run deploy`, never the bare `pnpm deploy` — that invokes pnpm's own built-in `deploy`
subcommand instead.

## Connectors

The Google Docs connector needs nothing on the server: its refresh token comes from Infisical as environment
variables (`docs/architecture/connectors.md`, way 1). The steps below are **only if the chosen server cannot read
its token from env**. The Google Docs server can, so this is a fallback for a future connector, not for this one.

```sh
ssh -L <port>:127.0.0.1:<port> jarvis@<host>     # <port> = the callback port the MCP server prints
# on the server, as jarvis:
<mcp server's auth command>                      # prints an https://accounts.google.com/... URL
# open that URL in the laptop's browser, grant access; the redirect to localhost:<port> goes through the tunnel
chmod 600 <token file>
```

The token then sits in plaintext on the server disk; see "Way 2" in the connectors doc for the risks and rotation.

## Rebuild after losing the server

1. Restore the Hetzner snapshot (it holds Postgres, `~/.jarvis` and `~/.claude`).
2. `claude -p "ping"` as `jarvis` must answer.
3. If it does not, log in again: `claude`, then `/login`.
4. `systemctl status jarvis-engine jarvis-web`
5. `curl -fsS http://127.0.0.1:4310/api/health`

## Update

The sequence is in [`deployment.md` §5](../docs/architecture/deployment.md#5-update); it is kept in one place only.

## Notes

- `After=docker.service` does not mean Postgres accepts connections. `scripts/wait-healthy.sh` (the unit's
  `ExecStartPost`) accepts both 200 and 503, so an engine that is up while Postgres is not stays up and says so;
  only a process that never answers fails the start, and `Restart=on-failure` retries that.
- `with-secrets.sh` passes no `--domain`, so it assumes Infisical Cloud US.

## Residual risk

A child `claude` runs as `jarvis`, the same user as the engine, so it can read `/proc/<engine-pid>/environ` and every
secret `infisical run` injected, including the short-lived `INFISICAL_TOKEN`. The allow-list in `child-env.ts` limits
what a child inherits; it cannot stop a same-uid process reading a sibling's environment. Accepted for now on a
single-owner box. The real fix is a separate uid for child `claude` processes (a task of its own: ADR-0015, worktree
permissions, `~/.claude`).

`jarvis` must not be in the `docker` group: that group is root-equivalent, and it would undo the `0600 root`
protection of `/etc/jarvis/infisical.env` for any child `claude` with `Bash` (deployment.md §1). Check with
`id -nG jarvis | grep -wc docker` (expect `0`).

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
