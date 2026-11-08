# Jarvis

Personal AI development agent that runs on your laptop through your Claude Code subscription.
You give it a task in its web chat (Slack threads in iteration 2); it gathers context (Claude Design, Notion, Google Docs, the repo),
writes a spec and plan, implements the change, runs checks, reviews it, opens a draft PR and
watches CI and review until the PR is ready for a human merge.

Status: proof of concept, specification stage.

- What it does: [`docs/specs/abstract-project-spec.md`](docs/specs/abstract-project-spec.md)
- How it is built: [`docs/architecture/README.md`](docs/architecture/README.md), decisions in [`docs/decisions/architecture/`](docs/decisions/architecture/README.md)
- Webinar concept: [`docs/webinar/webinar-concept.md`](docs/webinar/webinar-concept.md)
- UI brief for design: [`docs/specs/web-ui-design.md`](docs/specs/web-ui-design.md)

## Run it

Prerequisites: Node 22, pnpm 10, Docker (for Postgres), and Claude Code (`claude`) logged in with your
Claude subscription (run `claude`, then `/login`; `claude auth status` shows the result). Do not set `ANTHROPIC_API_KEY`: the engine refuses to start with an
API key, or with a `claude` login that is not a subscription.

```sh
mkdir -p ~/.jarvis
cp .env.example ~/.jarvis/.env                              # add GITHUB_TOKEN of the bot account when you want PRs followed
cp jarvis.config.example.json ~/.jarvis/jarvis.config.json  # set repo.path to your working repository, repo.remote to a remote name such as origin
docker compose up -d                                        # Postgres 18 on 127.0.0.1:5433
pnpm install
pnpm dev                                                    # engine on http://127.0.0.1:4310, web on http://127.0.0.1:5180
```

Open http://127.0.0.1:5180 and send a message. Both servers listen on loopback only; there is no login.
`JARVIS_HOME` moves the home folder from `~/.jarvis`. `pnpm test` runs all tests (the integration tests need the
Postgres container and never start the real `claude`).

After the first `pnpm dev`, `curl -s http://127.0.0.1:4310/api/connections` should report `claude: ok` with your
plan; the engine refuses to start while that check fails.

### If the engine cannot run `claude`

The engine runs the binary named by `engine.claudeBinary` (default `claude`) and gives the connection probe eight
seconds. Two things break that on a managed laptop:

- **A login in a non-default config directory.** Start the engine with `CLAUDE_CONFIG_DIR=$HOME/.claude-personal
pnpm dev`; the variable is passed through to every child `claude` (ADR-0007).
- **A `claude` on `PATH` that is a corporate wrapper.** Some managed machines shadow the real CLI with a wrapper
  that needs tens of seconds per call, so the probe times out and the engine exits. Point `engine.claudeBinary` at
  the binary the official installer wrote, or at a one-line shim that picks its newest version:

  ```sh
  mkdir -p ~/.jarvis/bin && cat > ~/.jarvis/bin/claude <<'SH'
  #!/bin/sh
  dir="$HOME/.local/share/claude/versions"
  ver=$(ls -t "$dir" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
  exec "$dir/$ver" "$@"
  SH
  chmod 755 ~/.jarvis/bin/claude   # then set engine.claudeBinary to this path
  ```

## Rehearse the server setup

The server will run Jarvis as a non-root Linux user with a headless `claude` login (ADR-0015). To try that
on the laptop first, the `server` profile of `compose.yaml` builds a Linux image (`docker/runtime`: Ubuntu 24.04,
Node 22, pnpm, git, gh, Claude Code, user `jarvis` uid 1000) and runs the engine and web in it (ADR-0017).
Postgres is the same `postgres` service. The profile is off unless you pass `--profile server`.

```sh
export TARGET_REPO=/absolute/path/to/your/working/repository   # mounted at /work/repo
docker compose --profile server build
docker compose --profile server run --rm engine sh -c \
  'sed "s#/absolute/path/to/your/working/repository#/work/repo#" jarvis.config.example.json > ~/.jarvis/jarvis.config.json'
docker compose --profile server run --rm engine claude        # /login, paste code; credentials land in claude-home
docker compose --profile server run --rm engine claude -p "ping"
docker compose --profile server up -d
curl -s http://127.0.0.1:4310/api/overview                     # /api/health arrives with the health task
```

The Linux `node_modules` lives in Docker volumes and is not the host's, so the first `build` plus `up` installs dependencies once (every start re-runs a fast `pnpm install --frozen-lockfile`).
Check the login layout with `docker compose --profile server run --rm engine ls -la /home/jarvis/.claude/.credentials.json`
(mode `600`). Secrets go in the `jarvis-home` volume (`/home/jarvis/.jarvis/.env`), never into the image. Only
`127.0.0.1` ports are published; inside the container the processes bind all interfaces
(`JARVIS_LISTEN_HOST=0.0.0.0`). The `web` container shares the engine's network namespace, so recreating the engine container means recreating `web` too.

**Not rehearsed:** systemd units and restart policy, journald, Tailscale, the firewall, the Hetzner kernel.
A green rehearsal is not a green server. Docker Desktop runs containers only while you are signed in.
