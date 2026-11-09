---
status: proposed
date: 2026-11-09
decision-makers: [] # owner: the services a check may run must be configurable, not buried in a shell string (2026-11-09); drafted by Claude
scope:
  [
    'shared/src/config.ts',
    'engine/src/application/ports/dev-server.ts',
    'engine/src/application/ui/start-dev-server.ts',
    'engine/src/infrastructure/dev-server/**',
    'jarvis.config.example.json',
    'docs/specs/ui-verification.md',
  ]
supersedes: []
superseded-by: []
---

# ADR-0019: A UI check's environment is declared per repository, not written as one shell command

## Context and Problem Statement

ADR-0014 gave the UI check exactly one knob for bringing an application up: `ui.devCommand`, a single
string the engine runs with `shell: true`. For a front end with no back end that was enough —
`npm run dev` and a readiness probe on one URL.

The first check that needed real data broke that assumption. T-5 (`burnjohn/quick-blog#38`,
2026-11-09) wanted the admin side walked: log in, publish an article, unpublish it, delete it, read
the comments. That needs a database with seeded rows and an API in front of it. What fits in
`ui.devCommand` is this:

```sh
set -e; export MONGOMS_DOWNLOAD_DIR=…; npm --prefix server ci … && npm --prefix client install …;
export MONGODB_URI=… PORT=5001 CLIENT_URL=… NODE_ENV=development GEMINI_API_KEY=…;
export JWT_SECRET=$(node -e "…"); (cd server && exec node -e "…MongoMemoryServer.create…") & MONGO=$!;
trap 'kill $MONGO $API' EXIT INT TERM; until node -e "…connect(27017)…"; do sleep 1; done;
(cd server && node scripts/seed.js); (cd server && exec node server.js) & API=$!;
until curl -sf http://127.0.0.1:5001/; do sleep 1; done; VITE_BASE_URL=… npm --prefix client run dev …
```

Eleven hundred characters that install packages, download a 114 MB database binary, seed it, start
two servers, probe both and arrange their teardown. Three things are wrong with that, and none of
them is the command's fault:

1. **It is unreviewable.** The owner's only control over what a check runs is reading this string
   and deciding whether to paste it. Ports, environment, readiness and cleanup are all implicit in
   shell punctuation. A reviewer cannot see at a glance which services exist or which ports they
   take.
2. **It is unreusable.** Every repository, and every change to one, is a fresh shell one-liner
   written from scratch. The next project needs Postgres and Redis instead, and none of this
   carries over.
3. **The engine already does this job, worse.** `ProcessDevServer` spawns a detached process group,
   polls a readiness URL with a timeout, holds one lease engine-wide and kills the group with
   SIGTERM escalating to SIGKILL. The shell string reimplements spawn, probe and teardown inside
   that, by hand, with `trap` and `until … sleep 1` loops that have no timeout of their own.

## Decision Drivers

- The owner asked for the permissions around this to be "formed and lifted out, with a config, so it
  is easy to change later".
- Whatever we build must not pretend to be a sandbox (see the honesty note below).
- `ui.devCommand` works today and must keep working; T-5 is mid-flight on it.

## Considered Options

1. **Declare the services as data, keyed by repository.** The engine starts them in order, probes
   each, and tears them down with the lease it already owns.
2. **An allow-list of permitted binaries** — `ui.mayRun: ["mongod", "node"]`, checked before a
   service starts.
3. **Leave `ui.devCommand` alone, add `ui.env` and a separate `ui.prepare` command.**
4. **Let the checked-out repository declare its own services** in a committed file, the way
   `AGENTS.md` declares check commands.

## Decision Outcome

**Option 1.** `ui` grows a list of services and a per-repository override; `ui.devCommand` stays as
the application process and as the whole story for a repository that declares no services.

```jsonc
"ui": {
  "repos": {
    "burnjohn/quick-blog": {
      "env": { "NODE_ENV": "development", "MONGODB_URI": "mongodb://127.0.0.1:27017/quickblog" },
      "prepare": "npm --prefix server ci --no-audit --no-fund && npm --prefix client install",
      "services": [
        {
          "name": "mongo",
          "command": "node -e \"…MongoMemoryServer.create({instance:{port:27017}})…\"",
          "cwd": "server",
          "ready": { "tcp": 27017 }
        },
        {
          "name": "seed",
          "command": "node scripts/seed.js",
          "cwd": "server",
          "oneShot": true
        },
        {
          "name": "api",
          "command": "node server.js",
          "cwd": "server",
          "ready": { "http": "http://127.0.0.1:5001/" }
        }
      ],
      "devCommand": "npm --prefix client run dev -- --host 127.0.0.1"
    }
  }
}
```

The engine runs `prepare` to completion, then each service in order — waiting for its `ready` probe,
or for it to exit when `oneShot` — then `devCommand`, then probes `ui.baseUrl` as it does now. Every
process joins the same detached group, so the existing kill path tears the whole environment down
unchanged. `readyTimeoutSeconds` applies per service rather than once for everything.

### What this is not

**It is not a sandbox, and the config must not be read as one.** `agent/settings/worker.json` puts a
bare `Bash` in the worker's allow-list — a deliberate choice recorded after narrow `Bash(cmd:*)`
prefixes made compound commands raise permission cards and stall runs. So a worker can start
`mongod`, or anything else, directly from `Bash`, with or without this config. Declaring services
here buys review, reuse and teardown; it buys no containment. The containment boundary is the
runtime container (ADR-0016) and the deny-list, and it stays there. Option 2 was rejected for
exactly this reason: an allow-list of binaries that `Bash` walks straight past is theatre, and a
safety control that does not control is worse than none, because it is believed.

### Why keyed by the owner's config and not the repository

Option 4 is the tempting one — a project knows how to run itself, and `AGENTS.md` already works that
way. It is rejected because a `ui_check` task stands on the head of a pull request that may come
from someone we do not know (ADR-0018), and ADR-0017 says content from such a head is data, never
instructions. A file in that tree saying "to run me, execute this" is precisely an instruction from
an untrusted head, and honouring it would hand an attacker the shell the whole untrusted-head card
exists to protect. The declaration therefore lives in the owner's config, where the owner wrote it.

A repository Jarvis owns could be trusted with its own file later. That is a separate decision and
needs the trust question answered first, not assumed.

### Consequences

- Good: what a check runs becomes a reviewable table — names, ports, probes — instead of shell
  punctuation. The owner can change a port or swap a database without rewriting a one-liner.
- Good: the per-service readiness probe and timeout replace hand-written `until … sleep 1` loops
  that could hang until the lease expired. The T-5 command has two such loops.
- Good: the engine's existing lease, process group and SIGTERM/SIGKILL path cover the services for
  free, because they are its children.
- Bad: `ProcessDevServer` grows from "spawn one thing and probe it" into a small ordered supervisor.
  That is new code in the adapter and needs its own integration tests.
- Bad: two ways to say the same thing (`ui.devCommand` alone, or `services` plus `devCommand`) until
  the old one is retired. It stays because retiring it would break a working setup mid-task.
- Neutral: environment values stay in the config, which means secrets must not go there — ADR-0015
  still applies, and a service needing a real credential reads it from the environment the engine
  already has, never from this file.

## More Information

- The shared binary cache (`MONGOMS_DOWNLOAD_DIR` into `~/.jarvis/cache/`) is an implementation
  detail of the quick-blog profile, not part of this decision, but it is the reason a 114 MB
  download happens once per machine rather than once per worktree.
- Open: whether `prepare` should be cached per worktree, and whether a service that exits
  unexpectedly mid-check should fail the check or only be reported in it.
