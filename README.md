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
Claude subscription (`claude auth login`). Do not set `ANTHROPIC_API_KEY`: the engine refuses to start with an
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
