# Deployment

How to run Jarvis on a server (ADR-0015) with secrets from Infisical (ADR-0016). Status: plan; the
steps marked **TODO** need code changes that are not made yet.

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
   install -d -m 0750 -o root -g jarvis /etc/jarvis
   printf 'INFISICAL_CLIENT_ID=...\nINFISICAL_CLIENT_SECRET=...\nINFISICAL_PROJECT_ID=...\n' > /etc/jarvis/infisical.env
   chown root:jarvis /etc/jarvis/infisical.env && chmod 0640 /etc/jarvis/infisical.env
   ```
4. Install the Infisical CLI on the server and on the laptop. Laptop: `infisical login && infisical run --env=dev -- pnpm dev`.

## 4. App

```sh
tailscale ssh jarvis@<host>
git clone https://github.com/burnjohn/jarvis-agent.git ~/jarvis && cd ~/jarvis
mkdir -p ~/.jarvis && cp jarvis.config.example.json ~/.jarvis/jarvis.config.json   # set repo.path, limits
docker compose up -d
pnpm install --frozen-lockfile && pnpm --filter @jarvis/web build
```

**TODO** (code): `web/vite.config.ts` needs a `preview` block (`127.0.0.1:5180`, the `/api` proxy, `allowedHosts: ['.ts.net']`), and a wrapper script that logs in to Infisical with the machine identity and runs `infisical run --env=prod -- <cmd>`.

`/etc/systemd/system/jarvis-engine.service` (sketch; `jarvis-web.service` is the same with `pnpm --filter @jarvis/web exec vite preview`):

```ini
[Unit]
Description=Jarvis engine
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=jarvis
WorkingDirectory=/home/jarvis/jarvis
EnvironmentFile=/etc/jarvis/infisical.env
ExecStart=/home/jarvis/jarvis/scripts/with-secrets.sh pnpm --filter @jarvis/engine start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now jarvis-engine jarvis-web` and `tailscale serve --bg 5180`. Open
`https://<host>.<tailnet>.ts.net` from any device in your tailnet.

## 5. Update

```sh
cd ~/jarvis && git pull && pnpm install --frozen-lockfile && pnpm --filter @jarvis/web build \
  && scripts/with-secrets.sh pnpm --filter @jarvis/engine db:migrate \
  && sudo systemctl restart jarvis-engine jarvis-web
```

## 6. Backups

Hetzner automatic backups (daily snapshot of the whole disk) cover Postgres, `~/.jarvis` and `~/.claude`.
After a restore, check `claude -p "ping"`; log in again if the session expired.
