# Deployment

How to run Jarvis on a server (ADR-0016) with secrets from Infisical (ADR-0015). Unit files, the
Infisical wrapper and the `vite preview` block are in [`deploy/`](../../deploy/README.md).

```mermaid
flowchart LR
    subgraph tailnet[Owner's tailnet]
        laptop([Laptop / phone])
        subgraph vps[Hetzner VPS, user jarvis]
            ts[tailscale serve :443]
            web[jarvis-web: vite preview 127.0.0.1:5180]
            engine[jarvis-engine: 127.0.0.1:4310]
            pg[(Postgres in Docker 127.0.0.1:5433)]
            claude["claude -p (subscription login in ~/.claude)"]
        end
    end
    inf[(Infisical: prod env)]
    gh[(GitHub)]

    laptop -- HTTPS --> ts --> web -- /api --> engine --> pg
    engine --> claude
    engine -- infisical run --> inf
    claude & engine --> gh
```

To try the Linux user, Node/pnpm and the headless `claude` login before the server exists, use the laptop
rehearsal in the README ("Rehearse the server setup", ADR-0016). It does not cover systemd, journald, Tailscale or
the firewall.

## 1. Server

1. Hetzner Cloud → new server: Ubuntu 24.04, 8–16 GB RAM (e.g. CX32/CX42), your SSH key, a firewall with inbound SSH only.
2. As root:
   ```sh
   adduser --disabled-password jarvis                               # NOT in the docker group (see below)
   # Docker Engine, git, gh, Node 22 (nvm or NodeSource), corepack enable (pnpm)
   curl -fsSL https://claude.ai/install.sh | bash                    # as jarvis, Claude Code CLI
   ln -sf /home/jarvis/.local/bin/claude /usr/local/bin/claude      # as root: systemd's PATH has no ~/.local/bin
   curl -fsSL https://tailscale.com/install.sh | sh && tailscale up --ssh
   ```

   **Commit identity.** A worker runs with `GIT_CONFIG_GLOBAL=/dev/null` (ADR-0022), so `git config --global`
   never reaches it. Give the engine unit the identity instead; the engine passes `GIT_AUTHOR_*` and
   `GIT_COMMITTER_*` through to every child `claude`:

   ```sh
   sudo systemctl edit jarvis-engine   # then, in the drop-in:
   # [Service]
   # Environment=GIT_AUTHOR_NAME=Jarvis GIT_COMMITTER_NAME=Jarvis
   # Environment=GIT_AUTHOR_EMAIL=<id>+<login>@users.noreply.github.com GIT_COMMITTER_EMAIL=<id>+<login>@users.noreply.github.com
   ```

   **Never add `jarvis` to the `docker` group.** The Docker daemon runs as root, so whoever can talk to its
   socket can start a container with the host's filesystem mounted and act as root. `jarvis` runs every child
   `claude`, and a worker has `Bash`, so membership would let a prompt injection read the root-only
   `/etc/jarvis/infisical.env` and anything else. Docker is driven as root only: the one-off `compose up`
   below, and any long-lived container a target repository needs (its restart policy keeps it up).
3. Once `tailscale ssh jarvis@<host>` works, remove SSH from the Hetzner firewall.
   **Rootless Docker for the UI check (ADR-0026).** The engine runs each UI check in disposable
   containers, as `jarvis`, through a rootless daemon — which gives a container no more than `jarvis`
   already has, so the rule above stands. Once, as root:
   ```sh
   apt-get install -y uidmap dbus-user-session docker-ce-rootless-extras
   loginctl enable-linger jarvis                      # the user daemon survives logout and reboot
   sudo -iu jarvis dockerd-rootless-setuptool.sh install
   sudo -iu jarvis systemctl --user enable --now docker
   id -u jarvis                                       # <uid> for the drop-in below
   sudo systemctl edit jarvis-engine
   # [Service]
   # Environment=DOCKER_HOST=unix:///run/user/<uid>/docker.sock
   # Environment=XDG_RUNTIME_DIR=/run/user/<uid>
   sudo -iu jarvis DOCKER_HOST=unix:///run/user/<uid>/docker.sock docker run --rm hello-world
   ```
   Without a daemon the engine does not hang: every `start_dev_server` is refused with
   `docker_unavailable` and the pull request says the UI check did not complete.
   Remove the retired keys from `~/.jarvis/jarvis.config.json` (`ui.devCommand`, `ui.baseUrl`,
   `ui.readyPath`, `ui.allowedOrigins`, `ui.env`) and delete `~/.jarvis/ui/`; the engine ignores them
   with a warning until then.
   _Open:_ the check network may still reach private addresses (RFC1918, the tailnet). Dropping that
   egress needs host firewall rules for the rootless network namespace and is not set up yet.
4. Chromium for the UI check (ADR-0014), as root, into a path `jarvis` can read:
   ```sh
   export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
   # the version Playwright MCP depends on (ARG PLAYWRIGHT_VERSION in docker/runtime/Dockerfile); another
   # version installs a Chromium revision the MCP does not look for
   npx --yes playwright@1.65.0-alpha-2026-10-30 install --with-deps chromium && chmod -R a+rX /ms-playwright
   ```
   Then put `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` in the engine unit's environment, and set
   `ui.noSandbox: true` in `jarvis.config.json` — the server has no user namespaces for Chromium's
   sandbox. Skipping this step is allowed: the UI check then reports `inconclusive` and the PR says so.
   Adds roughly 400 MB.

## 2. Claude login (once, interactively)

```sh
tailscale ssh jarvis@<host>
claude            # then /login, open the printed URL on your laptop, paste the code back
claude -p "ping"  # must answer without ANTHROPIC_API_KEY
```

## 3. Secrets (Infisical)

1. Infisical → project `jarvis`, environments `dev` and `prod`, variables as in [`.env.example`](https://github.com/burnjohn/jarvis-agent/blob/main/.env.example).
2. Organization → Machine identities → `jarvis-vps`, Universal Auth, read-only role on `prod`.
3. On the server, as root:
   ```sh
   install -d -m 0755 -o root -g root /etc/jarvis
   install -m 0600 -o root -g root /dev/null /etc/jarvis/infisical.env
   printf 'INFISICAL_CLIENT_ID=...\nINFISICAL_CLIENT_SECRET=...\nINFISICAL_PROJECT_ID=...\n' > /etc/jarvis/infisical.env
   ```

   The file is `root:root 0600`: systemd reads `EnvironmentFile=` as root, and a child `claude` running as `jarvis` must not be able to read the long-lived client secret.
4. Install the Infisical CLI on the server and on the laptop. Laptop: `infisical login && infisical run --env=dev -- pnpm dev`.
5. Postgres password (ADR-0015): generate one (`openssl rand -base64 24`), store it in Infisical as
   `POSTGRES_PASSWORD` and inside `DATABASE_URL` / `DATABASE_URL_TEST`. `compose.yaml` carries no
   default and refuses to start without it. On a volume created with the old default:
   `sudo docker compose exec postgres psql -U jarvis -c "ALTER USER jarvis PASSWORD '<new>'"`, then restart
   the engine. The local fallback is the same variables in `~/.jarvis/.env`; keep that file an export
   of Infisical (`infisical export --env=dev`), not a second source of truth.

## 3a. Connectors

Notion and Google credentials are Infisical variables, never an interactive login on the server; the order of
preference and the one SSH-tunnel fallback are in [`connectors.md`](connectors.md).

## 4. App

```sh
tailscale ssh jarvis@<host>
git clone https://github.com/burnjohn/jarvis-agent.git ~/jarvis && cd ~/jarvis
mkdir -p ~/.jarvis && cp jarvis.config.example.json ~/.jarvis/jarvis.config.json   # set repo.path, limits
# POSTGRES_PASSWORD has no default (ADR-0015); it comes from Infisical through the machine identity,
# which only root can read; Docker is root-only too, so compose runs as root with that EnvironmentFile:
sudo systemd-run --quiet --wait --pipe --collect --same-dir \
  -p EnvironmentFile=/etc/jarvis/infisical.env scripts/with-secrets.sh docker compose up -d
pnpm install --frozen-lockfile && pnpm --filter @jarvis/web build
```

The server keeps no `~/.jarvis/.env`: every secret, the database URL included, comes from Infisical `prod`.
`scripts/deploy.sh` runs its migrations the same way.

A redeploy never touches the database: `scripts/deploy.sh` does not call Docker, Postgres keeps its data in the
`pgdata` volume, and migrations are additive (ADR-0008). Only `docker compose down -v` (never part of any script
here) deletes that volume.

The units are `deploy/systemd/jarvis-engine.service` and `jarvis-web.service`; the wrapper is `scripts/with-secrets.sh`
(logs in to Infisical with the machine identity and runs `infisical run --env=prod -- <cmd>`; without
`INFISICAL_CLIENT_ID` it runs the command unchanged). Install:

```sh
sudo cp deploy/systemd/jarvis-*.service /etc/systemd/system/ && sudo systemctl daemon-reload
```

`After=docker.service` does not mean Postgres accepts connections. The unit's start gate
(`scripts/wait-healthy.sh`) accepts 503 as "alive, database down", so the engine is not killed while Postgres comes up.

Then `systemctl enable --now jarvis-engine jarvis-web` and `tailscale serve --bg 5180`. Open
`https://<host>.<tailnet>.ts.net` from any device in your tailnet.

## 5. Update

From the laptop, over Tailscale SSH:

```sh
pnpm run redeploy             # the usual way: see below
pnpm run deploy:remote        # the bare deploy: ssh root@jarvis-01 /home/jarvis/jarvis/scripts/deploy.sh
```

`pnpm run redeploy` (`scripts/redeploy.sh`) is the manual redeploy in one command. It shows the commits
that are about to go out, waits for live runs to finish so a working agent is not cut off mid-turn (up to
10 minutes; `-- --wait 30` to wait longer, `-- --now` to interrupt them — they resume after the restart),
runs `scripts/deploy.sh` on the server, then checks `/api/health` and the units and prints the commit that
is live. `-- --check` only shows what would be deployed and whether a run is live. With nothing new on
`main` it restarts the same commit, which is how to bounce the engine after a config or unit change.
`JARVIS_HOST` overrides the host (default `root@jarvis-01`).

`jarvis` has no password and no sudo rule, so the deploy runs as root; the script then runs every git and
pnpm step as `jarvis` (`runuser`), so nothing in the checkout ends up owned by root, and only `systemctl` and
`systemd-run` run as root. On the server as `jarvis`, `cd ~/jarvis && pnpm run deploy` works too, but only once a
sudo rule for those two commands exists.

`pnpm run deploy` runs [`scripts/deploy.sh`](../../deploy/README.md#deploy-script), which wraps the exact sequence
above (pull, install, build, migrate, restart) behind one lock-protected command. Use `pnpm run deploy`, not
`pnpm deploy` — the bare form is pnpm's own built-in `deploy` subcommand (for packaging a workspace project), not
this repo's script.

## 6. Backups

Hetzner automatic backups (daily snapshot of the whole disk) cover Postgres, `~/.jarvis` and `~/.claude`.
After a restore, check `claude -p "ping"`; log in again if the session expired.
