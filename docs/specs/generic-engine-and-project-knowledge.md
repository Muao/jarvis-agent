# Generic engine and project knowledge — design

**Status:** approved by the owner 2026-11-10 · **Date:** 2026-11-10 · **Owner rulings:** 2026-11-10 (chat)

## Why

Jarvis is a general-purpose engine. Today it knows things about one particular target repository:
`~/.jarvis/jarvis.config.json` carries `ui.devCommand` pointing at a hand-written
`~/.jarvis/ui/quick-blog-dev.sh`, and `ui.env` holds quick-blog's MongoDB URI and `JWT_SECRET` in
plain text. ADR-0019 (proposed) would go further and add a `ui.repos["burnjohn/quick-blog"]` block
listing that repo's services. The cost showed up on 2026-11-10: T-3 targeted Jarvis's own repository
and `start_dev_server` started quick-blog's script, because there is only one `ui` block for every
repository.

The owner's rulings (2026-11-10):

1. **Nothing about target projects lives in the Jarvis repository or in its config** — no launch
   commands, no services, no credentials. The engine is generic.
2. **The agent works it out at runtime**: how to bring a project up, what it needs, which local
   credentials to use.
3. **What the agent learned about a project is kept per project** — not in the general memory
   (`USER.md`), but in a project record named after the project, holding everything the agent knows
   about it — so the next task does not rediscover it.
4. **The mechanism is formalised** (a skill and whatever engine support it needs), and the ADRs are
   changed so the old per-repo-config approach is not proposed again.
5. **Credentials of a target project are never stored**, anywhere.
6. **As few questions to the owner as possible.** Whatever can be decided by a rule, the engine
   decides; whatever needs judgement inside the guardrails, the agent decides; the owner is asked
   only where a guardrail itself is at stake. Every such decision is journalled and visible
   afterwards, never silent.

## Goals

- Remove every target-specific value from `jarvis.config.json`, `jarvis.config.example.json`, the
  repository's code, tests, docs and ADRs.
- A UI check on any allow-listed repository brings the app up with no per-repo setup by the owner.
- A project record per repository that the agent reads at the start of every run on that repo and
  keeps up to date.
- The second UI check on the same repository reuses the recorded way to run it and spends no
  discovery effort unless that way stopped working.

## Non-goals

- Changing who may target which repository (the allow-list, ADR-0012) — see Decision 1.
- Changing the general owner memory in `USER.md` beyond moving the repo-scoped part out (Decision 2).
- Caching dependencies between checks (a later optimisation, ADR-0019 already names the fix).

## Anti-goals (a failure even if it works)

- A target project's secret — a password, a token, a `JWT_SECRET`, a connection string with a
  password — written to disk by Jarvis, in the project record, the journal, a log or a PR.
- A model-chosen command running **on the host** with the engine's uid, environment or files in
  reach. Letting the agent choose the command is acceptable only because the command runs inside a
  disposable container (see "Where it runs").
- The project record turning into a second config file the owner has to maintain by hand.

## How it works

### 1. The agent discovers how to run the project

In `Reviewing` (build task) or in a `ui_check` task, the worker reads the target repository with the
tools it already has (Read, Grep, Glob — a `ui_check` worker still has no shell): `README`,
`AGENTS.md` / `CLAUDE.md`, `package.json` scripts, `.env.example`, `docker-compose*.yml`,
`Dockerfile`, framework config. From that and the project record (below) it composes an
**environment plan**:

```jsonc
{
  "image": "node:22-bookworm",              // a public image; default node:22-bookworm
  "prepare": ["npm --prefix server ci", "npm --prefix client install"],
  "services": [
    { "name": "db",  "command": "…", "cwd": "server", "ready": { "tcp": 27017 } },
    { "name": "api", "command": "node server.js", "cwd": "server",
      "ready": { "http": "http://127.0.0.1:5001/" } }
  ],
  "app": { "command": "npm --prefix client run dev -- --host", "port": 5173, "readyPath": "/" },
  "extraPorts": [5001],                     // other origins the browser must reach (API)
  "env": {
    "NODE_ENV": "development",
    "MONGODB_URI": "mongodb://127.0.0.1:27017/app",
    "JWT_SECRET": { "generate": true }       // the engine makes a random value per check
  }
}
```

and calls `start_dev_server(plan)`. This replaces today's argument-less tool. The plan's format is
the one ADR-0019 designed for the config; only its author changes — from the owner's config to the
agent at runtime.

**Credentials.** A variable the app needs as a secret is declared `{ "generate": true }`. The engine
generates a random value for that one check, passes it into the containers and forgets it. It is not
returned to the agent, not journalled, not written into the project record. Other values may refer to
a generated one as `${NAME}` (e.g. `"MONGODB_URI": "mongodb://app:${DB_PASSWORD}@db:27017/app"`), so a
database password is generated too, never written. *My call:* the line is "no literal credential
anywhere in a plan" — a plan `env` value or a service command that carries a literal password, token
or high-entropy string is refused with a reason; only `${NAME}` references to generated values pass.
That keeps the `Run` section safe to store verbatim.

**Databases and other backing services** run as their own containers from public images
(`mongo:7`, `postgres:16`, `redis:7`) on a network private to the check, reachable from the app by
service name. *My call:* a plan may name an image per service, rather than forcing everything into one
node image.

**Failure loop.** If a step fails, the tool returns which step, the exit code and the tail of its
output. The worker may revise the plan and try again, up to `ui.maxStartAttempts` (a new generic
limit, default 3) per run, and then reports that it could not bring the app up, with what it tried.

### 2. Where it runs

Every dev server — build task and `ui_check` alike — runs inside **one disposable Docker container
per check**, as ADR-0019 already designed: worktree bind-mounted, no engine environment, no
`~/.claude`, no `~/.jarvis`, ports published on loopback, labelled with the task id, removed on lease
expiry, run exit, engine shutdown, and found and removed at engine start. The host-process
`ProcessDevServer` is retired. *My call:* one path for both task kinds instead of two, because
model-chosen commands are now the norm and the container is what makes that safe; the build task's
worker already has a shell, but the dev server is long-lived and gets the extra containment for
free.

Network (*my call*): the check's containers may reach the internet (`npm ci`, image pulls) but not
the host or the private networks — a dedicated Docker network whose egress to RFC1918, the Tailscale
range `100.64.0.0/10` and the host's addresses is dropped. The engine, its Postgres and the web UI
are bound to `127.0.0.1` and are not reachable from a container in any case. A plan cannot choose the
network, mounts, capabilities, user or privileged mode; the engine sets them.

Ports: the engine maps the plan's container ports to free host ports and tells the agent and
Playwright MCP the host URLs; this also removes the clash with Jarvis's own 4310/5180 that blocked
T-3. Playwright's allowed origins are derived from `app` and `extraPorts`, not configured.

### 3. The project record

One directory per repository under Jarvis's home, never in the Jarvis repo or the target repo:

```
~/.jarvis/projects/<owner>/<name>/PROJECT.md
```

`PROJECT.md` is Markdown with fixed sections, written for both the agent and the owner to read:

```markdown
# burnjohn/quick-blog

## Overview            what it is, stack, layout (client/, server/), where things live
## Run                 the environment plan that last worked, as a json block, + notes
## Checks              test / lint / typecheck commands and what they need
## Conventions         code and PR conventions noticed or told
## Gotchas             things that broke and why
## History             one line per change: date, task, what changed
```

- **Who writes.** The worker, through engine MCP tools — `read_project()` and
  `update_project(section, content, reason)` — never by editing the file directly; the engine owns
  the path, appends the `## History` line (date, task id, reason) and refuses content matching secret
  patterns. The owner may edit the file by hand.
- **The `Run` section is written by the engine itself** after a `start_dev_server(plan)` that reached
  ready: the plan, with every `{ "generate": true }` kept as that marker, never a value. No model has
  to remember to save it.
- **Who reads.** The engine puts `PROJECT.md` into the first message of every worker run on that
  repository (as it does `USER.md`), trimmed to a size limit (`memory.projectMaxKb`, generic).
- **`ui_check` tasks** read the record but write nothing to it, the `Run` section included
  (ADR-0021's rule for untrusted heads stands). *My call:* only a build task — the owner's own branch —
  records a working plan, so a stranger's pull request cannot plant a plan that later runs for
  everyone. A plan from the record is still only ever executed inside the container.
- **When `Run` changes** (*my call*): only after a plan reached ready. A failed start never overwrites a
  recorded plan; it adds a line to `## Gotchas` instead. If the recorded plan fails and a revised one
  reaches ready, the revised one replaces it.
- **Concurrent writes** (*my call*): the engine serialises writes per record file (one in-process
  lock; the engine is the only writer besides the owner's editor). Each write is
  read-modify-write-rename, so a crash never leaves a half-written file.
- **Viewing.** The Config page lists project records read-only next to `USER.md`. *My call:* no
  in-app editor in this step.

### 4. The skill

`agent/skills/project-knowledge/SKILL.md`, loaded by the worker (and referenced from WRK-10 in
`agent/prompts/worker.md`):

- when to read the record and trust it, and when to re-verify (a cited file changed, a plan failed);
- how to discover a run plan from a repository's own files, in order of trust (`AGENTS.md` →
  compose files → `package.json` scripts → README), and how to compose services, ports and env;
- the credential rule: secrets are `{ "generate": true }`, never literals, never copied from a
  `.env` file found in the repo;
- what belongs in each section and what never does (credentials, one-off task details);
- how to report a failed start: what was tried, what failed, what the owner could provide.

The existing `sdd-flow` skill and the WRK-10 prompt text that refers to `ui.devCommand` are updated
to point at it.

### 5. Removing what is there now

- **Config schema (`shared/src/config.ts`)**: drop `ui.devCommand`, `ui.baseUrl`, `ui.readyPath`,
  `ui.allowedOrigins`, `ui.env`. Keep the generic knobs (`enabled`, timeouts, lease, scenario and
  screenshot limits, `attachToPr`, `autoApproveComments`, `noSandbox`, `paths`), add
  `ui.maxStartAttempts`, `ui.defaultImage`. A config that still has the dropped keys loads with a
  warning naming them, so the server does not fail to start after the deploy.
- **The server**: remove those keys from `~/.jarvis/jarvis.config.json`, delete
  `~/.jarvis/ui/quick-blog-dev.sh`, and drop quick-blog's Mongo/JWT values — they are dev values, but
  they leave config by rule.
- **The repository**: test fixtures and examples use a neutral name (`acme/shop`) instead of
  `burnjohn/quick-blog`; ADR examples likewise. *My call:* rewrite the examples rather than leave
  real repo names in tests.
- **ADRs**: a new ADR-0026 "The engine knows no target project; the agent discovers how to run it and
  keeps a project record" supersedes ADR-0019 and amends ADR-0014 (the "no model picks the command"
  rule becomes "a model-picked command runs only inside the disposable container") and ADR-0021 (the
  repo-scoped part of memory moves to project records, Decision 2) and ADR-0022 (base-branch
  comparison, pre-run on base, refresh from base). ADR-0019 is
  marked superseded with a one-paragraph note why, so the per-repo-config idea is not raised again.
- **`AGENTS.md` of this repository**: engine test command becomes `test:unit`; integration tests are
  CI-only (ADR-0012). Unrelated to quick-blog but found in the same incident.

### 6. Checks that can actually pass

**The incident (T-3, 2026-11-10).** The frozen check list (ADR-0022) held
`pnpm --filter @jarvis/engine test`, which includes integration tests that need a Postgres the check
environment deliberately does not get. The command was red whatever the agent did; the engine burned
retries on it, the agent misdiagnosed it as a broken database password, and since a frozen list can
only change by re-approving the spec — impossible after `Context` — the task had no way out but a
hand-written journal row. Nothing about this is specific to one repository.

**The rule: a check is judged against the base branch.** When a frozen command fails on the task's
head, the engine runs the same command once on the base commit (`main` at the task's merge base, in a
scratch worktree, same stripped environment, same timeout):

- **Red on the head, green on base** → the task broke it. Behaviour as today: a retry is counted and
  the worker gets the log.
- **Red on both** → a pre-existing or environmental failure, not the task's. The engine decides on its
  own, without asking: the command does not block `open_pr`, no retry is counted, the worker is told
  plainly that the failure is not its to fix, and the PR body gets a section "Fails on `main` too"
  with the command and the log tail. The journal records `check_preexisting {command, baseSha}`.
- The base result is cached per (command, base sha), so a repository with a red `main` pays for the
  base run once, not once per attempt.

**Before approval: the list is pre-run on base.** While the task is in `Context`, the engine runs the
candidate commands once on the base commit. A command red on base is dropped from the proposed list
automatically and recorded in the project record (`## Checks`, with why). The spec card shows the
final list and, below it, the dropped ones with the reason — information, not a question.

**No dead ends: the engine refreshes a frozen list by itself.** When the base branch's `AGENTS.md`
check commands change after a task's approval (as `ca67aa5` did), the engine re-resolves the list from
the **base** branch — never the task's branch, so the worker still cannot edit its own checks — and
journals a new `checks_fixed {source: 'base_refresh'}`. The owner is told in the thread, not asked.

**The agent may skip a check that will not pass (owner ruling, 2026-11-10).** CI runs the full suite
on the pull request, so a local check that cannot be made green must not hold the PR back. The worker
may call `open_pr` with `skip: [{ command, reason }]` for frozen commands that ran red on the current
head at least once (the engine verifies this from the journal; a command never run cannot be
skipped). The engine then opens the PR as usual — still a draft — with a section "Checks skipped
locally — CI decides" naming each command, the reason and the log tail, and journals
`check_skipped {command, reason, headSha}`. No owner question. Skipping is the agent's call and is
expected for failures it judges environmental or outside the diff; the prompt tells it not to skip a
failure its own diff caused when it can fix it within the retry budget.

**The agent stops asking about environments.** The worker prompt and the project-knowledge skill say:
a check failing for reasons outside the diff (missing service, credentials, ports, flakiness the base
shares) is the engine's to classify, not a question for the owner; the worker reports it and moves on.
`ask_owner` stays for product decisions and guardrails.

**Where the owner is still asked** — only these, deliberately: the spec approval itself (existing),
running an untrusted pull request's code (ADR-0018), and anything that would widen a guardrail (a new
secret, the allow-list, a permission).

## Rollout (*my call*)

One release: the schema change, the new `start_dev_server(plan)` contract, the Docker adapter, the
skill and the WRK-10 prompt land together. No task is in `Reviewing` with a lease across a deploy
(leases die with the engine), so there is nothing to migrate. The laptop path uses Docker Desktop;
bind mounts of the worktree work there the same way.

## Constraints

- No new dependencies beyond the Docker CLI the engine already relies on (ADR-0019, ADR-0011).
- Onion layering (ADR-0002): plan schema in `shared`, the use case in `application/ui`, the Docker
  adapter in `infrastructure/dev-server`, the project store behind a port like `ProfileStore`.
- A missing Docker daemon refuses the UI check with a clear reason; it does not hang.

## Left to the builder

- The exact plan schema limits (max services, max command length, allowed image name pattern).
- Free-port allocation and how readiness probes are timed out per step.
- The size limit and trimming order for `PROJECT.md` in the prompt.
- Test strategy: unit tests for the plan schema, secret refusal and record writes; an integration
  test for the Docker adapter (CI-only, like the other int tests).

## Decisions taken without the owner (owner ruling 6)

These were open questions; the owner asked for them to be decided rather than asked.

0. **How the engine runs containers: rootless Docker for `jarvis`.** `jarvis` stays out of the
   `docker` group (`docs/architecture/deployment.md`). A rootless daemon running as `jarvis` gives a
   container no more than `jarvis` already has, and the CLI is the same as on the laptop. One-time
   server setup (`dockerd-rootless-setuptool.sh`, subuid/subgid ranges) goes into
   `docs/architecture/deployment.md`. The narrow sudo helper is rejected: more security-critical code
   and a sudo rule for no gain.
1. **The repository allow-list stays in config.** `repos.allow`, `repos.allowSelf` and `repo.path` say
   which repositories Jarvis may touch — a permission, not knowledge about how to run them — and
   permissions are the owner's (ADR-0012). Nothing else about a target lives in config.
2. **Repo-scoped memory moves to project records.** The `### owner/name` subsections under
   `## Learned` in `USER.md` move into that repository's `PROJECT.md` (`## Conventions` /
   `## Gotchas`), keeping ids, counters and dates; `USER.md` keeps only what applies everywhere. The
   ADR-0021 tools (`note_insight`, `confirm_insight`, …) write repo-scoped entries to the project record
   from then on. A one-time migration does the move and is idempotent.

## Side finding

`jarvis` is a member of the `sudo` group on the server while the deployment skill says it has no sudo
rule. To be checked against `docs/architecture/deployment.md` separately; not part of this work.
