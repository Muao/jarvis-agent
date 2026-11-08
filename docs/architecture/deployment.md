# Deployment

How to run Jarvis on a server (ADR-0015) with secrets from Infisical (ADR-0016). Unit files, the
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
rehearsal in the README ("Rehearse the server setup", ADR-0017). It does not cover systemd, journald, Tailscale or
the firewall.

## 1. Server

1. Hetzner Cloud → new server: Ubuntu 24.04, 8–16 GB RAM (e.g. CX32/CX42), your SSH key, a firewall with inbound SSH only.
2. As root:
   ```sh
   adduser --disabled-password jarvis && usermod -aG docker jarvis   # after installing Docker
   # Docker Engine, git, gh, Node 22 (nvm or NodeSource), corepack enable (pnpm)
   curl -fsSL https://claude.ai/install.sh | bash                    # as jarvis, Claude Code CLI
   curl -fsSL https://tailscale.com/install.sh | sh && tailscale up --ssh
   ```
3. Once `tailscale ssh jarvis@<host>` works, remove SSH from the Hetzner firewall.

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

## 3a. Connectors

Notion and Google credentials are Infisical variables, never an interactive login on the server; the order of
preference and the one SSH-tunnel fallback are in [`connectors.md`](connectors.md).

## 4. App

```sh
tailscale ssh jarvis@<host>
git clone https://github.com/burnjohn/jarvis-agent.git ~/jarvis && cd ~/jarvis
mkdir -p ~/.jarvis && cp jarvis.config.example.json ~/.jarvis/jarvis.config.json   # set repo.path, limits
docker compose up -d
pnpm install --frozen-lockfile && pnpm --filter @jarvis/web build
```

The units are `deploy/systemd/jarvis-engine.service` and `jarvis-web.service`; the wrapper is `scripts/with-secrets.sh`
(logs in to Infisical with the machine identity and runs `infisical run --env=prod -- <cmd>`; without
`INFISICAL_CLIENT_ID` it runs the command unchanged). Install:

```sh
sudo cp deploy/systemd/jarvis-*.service /etc/systemd/system/ && sudo systemctl daemon-reload
```

`After=docker.service` does not mean Postgres accepts connections; the `Restart=on-failure` cycle covers that gap.

Then `systemctl enable --now jarvis-engine jarvis-web` and `tailscale serve --bg 5180`. Open
`https://<host>.<tailnet>.ts.net` from any device in your tailnet.

## 5. Update

```sh
cd ~/jarvis && pnpm run deploy
```

`pnpm run deploy` runs [`scripts/deploy.sh`](../../deploy/README.md#deploy-script), which wraps the exact sequence
above (pull, install, build, migrate, restart) behind one lock-protected command. Use `pnpm run deploy`, not
`pnpm deploy` — the bare form is pnpm's own built-in `deploy` subcommand (for packaging a workspace project), not
this repo's script.

## 6. Backups

Hetzner automatic backups (daily snapshot of the whole disk) cover Postgres, `~/.jarvis` and `~/.claude`.
After a restore, check `claude -p "ping"`; log in again if the session expired.
