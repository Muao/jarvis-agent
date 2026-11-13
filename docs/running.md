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

## First project setup

1. Install Git, GitHub CLI, Node 22, pnpm 10, Docker with Compose, and Claude Code. Open a terminal in the Jarvis checkout. Start Docker.
2. Create or sign in to your human GitHub account. Use HTTPS for the setup, and set your Git commit identity if this machine is new.

   ```sh
   gh auth login --hostname github.com --git-protocol https --web
   gh auth setup-git --hostname github.com
   git config --global user.name "Your Name"
   git config --global user.email "your-verified-email@example.com"
   ```

3. Run `pnpm create-project`. Choose the GitHub namespace, project name, and a new local folder. The wizard confirms before creating a private GitHub repository, pushing its first commit on `main`, and generating Jarvis's config and local Postgres credentials.
4. For draft PRs and CI follow-up, create a separate GitHub bot account and give it write access. For a repository-scoped fine-grained token, choose an organization namespace in step 3 and add the bot as an organization member with access to the repository. GitHub fine-grained tokens have a [collaborator limitation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations). As the bot, create a fine-grained token for the selected repository with Contents and Pull requests read/write, Checks and Commit statuses read, and Actions read/write for CI logs and reruns. Complete organization approval if required. Put it in Infisical as `GITHUB_TOKEN`, or fill in `GITHUB_TOKEN` in the local fallback file `~/.jarvis/.env`. You can start chat with this field empty and complete GitHub access before trying a draft PR.
5. Run `claude` and sign in with your Claude subscription. Start Postgres and Jarvis from the Jarvis checkout.

   ```sh
   export COMPOSE_ENV_FILES="$HOME/.jarvis/.env"
   docker compose up -d --wait
   pnpm install
   pnpm dev
   ```

   If you used a custom `JARVIS_HOME`, point `COMPOSE_ENV_FILES` at that directory's `.env` and start the engine with that file loaded into the process environment. For a wizard-generated file, run `set -a; . "$COMPOSE_ENV_FILES"; set +a` before `pnpm dev`. For Infisical, start Jarvis with its secrets injected into the environment.

6. Open [Jarvis](http://127.0.0.1:5180) and ask for a small first task, such as adding a short description to the README. For GitHub verification, follow the task through spec approval and draft PR creation.

## Create a project with an existing local setup

Wait for active tasks to finish, then stop `pnpm dev`. Run `pnpm create-project` from the Jarvis checkout. The wizard creates the repository and switches the default in your existing `jarvis.config.json`. It prints the path of the backup. Restart with your usual `pnpm dev` command using your existing environment and database. Check that the existing GitHub bot token grants access to the new repository before opening a draft PR.

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
