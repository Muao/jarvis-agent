# Running Jarvis

Prerequisites: Node 22, pnpm 10, Docker (for Postgres), and Claude Code (`claude`) logged in with your
Claude subscription (run `claude`, then `/login`; `claude auth status` shows the result). Do not set `ANTHROPIC_API_KEY`: the engine refuses to start with an
API key, or with a `claude` login that is not a subscription.

```sh
mkdir -p ~/.jarvis
cp .env.example ~/.jarvis/.env                              # set POSTGRES_PASSWORD (openssl rand -base64 24) and the DATABASE_URLs; add GITHUB_TOKEN of the bot account when you want PRs followed
cp jarvis.config.example.json ~/.jarvis/jarvis.config.json  # set repo.path to your working repository, repo.remote to a remote name such as origin
export COMPOSE_ENV_FILES=~/.jarvis/.env                     # compose has no default Postgres password (ADR-0015)
docker compose up -d                                        # Postgres 18 on 127.0.0.1:5433
pnpm install
pnpm dev                                                    # engine on http://127.0.0.1:4310, web on http://127.0.0.1:5180
```

Open http://127.0.0.1:5180 and send a message. Both servers listen on loopback only; there is no login.
`JARVIS_HOME` moves the home folder from `~/.jarvis`. `pnpm test` runs all tests (the integration tests need the
Postgres container and never start the real `claude`).

After the first `pnpm dev`, `curl -s http://127.0.0.1:4310/api/connections` should report `claude: ok` with your
plan; the engine refuses to start while that check fails.

## Local UI against the server's engine

To work on the UI while the agent itself runs on the server ([deployment](architecture/deployment.md)), skip the local
engine and point the dev proxy at the server's tailnet address:

```sh
cp web/.env.remote.example web/.env.remote   # set JARVIS_API_URL (`tailscale serve status` on the server)
pnpm dev:remote                              # UI with hot reload on http://127.0.0.1:5180, /api -> the server
```

It checks the server's `/api/health` first and needs port 5180 free, so stop the rehearsal containers if they run.
Tasks, threads and runs are the server's; nothing runs on the laptop but Vite.

## Rehearse the server setup

The server will run Jarvis as a non-root Linux user with a headless `claude` login (ADR-0016). To try that
on the laptop first, the `server` profile of `compose.yaml` builds a Linux image (`docker/runtime`: Ubuntu 24.04,
Node 22, pnpm, git, gh, Claude Code, user `jarvis` uid 1000) and runs the engine and web in it (ADR-0016).
Postgres is the same `postgres` service. The profile is off unless you pass `--profile server`.

```sh
export TARGET_REPO=/absolute/path/to/your/working/repository   # mounted at /work/repo
export COMPOSE_ENV_FILES=~/.jarvis/.env                        # POSTGRES_PASSWORD, as above (ADR-0015)
docker compose --profile server build
docker compose --profile server run --rm engine sh -c \
  'sed "s#/absolute/path/to/your/working/repository#/work/repo#" jarvis.config.example.json > ~/.jarvis/jarvis.config.json'
docker compose --profile server run --rm engine claude        # /login, paste code; credentials land in claude-home
docker compose --profile server run --rm engine claude -p "ping"
docker compose --profile server up -d
curl -s http://127.0.0.1:4310/api/health
```

The Linux `node_modules` lives in Docker volumes and is not the host's, so the first `build` plus `up` installs dependencies once (every start re-runs a fast `pnpm install --frozen-lockfile`).
Check the login layout with `docker compose --profile server run --rm engine ls -la /home/jarvis/.claude/.credentials.json`
(mode `600`). Secrets go in the `jarvis-home` volume (`/home/jarvis/.jarvis/.env`), never into the image. Only
`127.0.0.1` ports are published; inside the container the processes bind all interfaces
(`JARVIS_LISTEN_HOST=0.0.0.0`). The `web` container shares the engine's network namespace, so recreating the engine container means recreating `web` too.

**Not rehearsed:** systemd units and restart policy, journald, Tailscale, the firewall, the Hetzner kernel.
A green rehearsal is not a green server. Docker Desktop runs containers only while you are signed in.
