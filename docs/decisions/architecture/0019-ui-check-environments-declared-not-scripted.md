---
status: proposed
date: 2026-11-09
decision-makers: [] # owner: the services a check may run must be configurable, not buried in a shell string (2026-11-09); owner: build the sandbox without Daytona-class infrastructure (2026-11-09); drafted by Claude
scope:
  [
    'shared/src/config.ts',
    'engine/src/application/ports/dev-server.ts',
    'engine/src/application/ui/start-dev-server.ts',
    'engine/src/infrastructure/dev-server/**',
    'jarvis.config.example.json',
    'docs/specs/ui-verification.md',
    'docs/specs/ui-check-on-demand.md',
  ]
supersedes: []
superseded-by: []
---

# ADR-0019: A UI check's environment is declared per repository and runs in a disposable container

## Context and Problem Statement

Two problems meet in the same place, and this record resolves them together because each one's
natural fix is half of the other's.

**The declaration problem.** ADR-0014 gave the UI check one knob for bringing an application up:
`ui.devCommand`, a single string run with `shell: true`. The first check that needed real data
outgrew it: T-5 (`burnjohn/quick-blog#38`, 2026-11-09) needed MongoDB seeded, an API in front of
it, and a Vite client — eleven hundred characters of shell that install packages, start two
servers, probe both with hand-written `until … sleep 1` loops and arrange their own teardown with
`trap`. Unreviewable (the owner's only control is reading the string), unreusable (the next repo
starts from scratch), and a worse reimplementation of the spawn-probe-teardown the engine already
has.

**The containment problem.** A `ui_check` task runs a pull request's head that may come from
someone we do not know (ADR-0018). The approval card asks whether that code may run; what it gets
once running used to be "everything the engine has". Three narrowing steps have landed since —
the dev server inherits a short env list plus the owner's declared `ui.env` (2026-11-09), the
`ui_check` worker lost its shell, its editors and its `GH_TOKEN`, and chat lost the ability to
edit `ui.env` / `ui.allowedOrigins` / `ui.autoApproveComments` — but they all narrow *what is
handed over*, not *where the code runs*. The head's `postinstall` scripts still execute as the
engine's own uid: they can read `~/.claude` (the subscription login), `~/.jarvis` (config),
`/proc/<engine>/environ`, and reach anything on the host's network. STATUS.md carries this as a
known gap.

An earlier draft of this record declared the services as data and ran them as host processes in
"the same detached process group". That was wrong twice: Node's `spawn({ detached: true })`
creates a **new** process group per child — a process cannot join another's group — so the
single-pid state file and `recover()` would have covered only the last service and orphaned the
rest; and a host-process supervisor would have rebuilt exactly the containment gap above, with
more moving parts.

## Decision Drivers

- The owner asked for the environment to be "formed and lifted out, with a config, so it is easy
  to change later".
- The owner ruled Daytona-class remote sandboxes out as disproportionate for a single-owner box.
- `ui.devCommand` works today — T-5 ran on it — and must keep working for the owner's own repos.
- Whatever claims to be a boundary must actually be one (the lesson of the rejected binary
  allow-list: a control that does not control is worse than none, because it is believed).

## Considered Options

1. **Services as data, run as host processes** — the earlier draft of this record.
2. **An allow-list of permitted binaries** — `ui.mayRun: ["mongod", "node"]`.
3. **Leave `ui.devCommand` alone, add `ui.env` and a separate `ui.prepare` command.**
4. **Let the checked-out repository declare its own services** in a committed file.
5. **Services as data, run inside a disposable Docker container per check.**
6. **A remote or microVM sandbox** (Daytona, Firecracker, gVisor).

## Decision Outcome

**Option 5.** The declaration from the earlier draft stays — it was the right format; only the
executor changes. `ui` grows a per-repository block; `ui.devCommand` alone stays as the whole
story for a repository that declares nothing:

```jsonc
"ui": {
  "repos": {
    "burnjohn/quick-blog": {
      "image": "node:22-bookworm",            // the container; default node:22-bookworm
      "env": { "NODE_ENV": "development", "MONGODB_URI": "mongodb://127.0.0.1:27017/quickblog" },
      "prepare": "npm --prefix server ci --no-audit --no-fund && npm --prefix client install",
      "services": [
        { "name": "mongo", "command": "node -e \"…MongoMemoryServer.create…\"", "cwd": "server",
          "ready": { "tcp": 27017 } },
        { "name": "seed",  "command": "node scripts/seed.js", "cwd": "server", "oneShot": true },
        { "name": "api",   "command": "node server.js", "cwd": "server",
          "ready": { "http": "http://127.0.0.1:5001/" } }
      ],
      "devCommand": "npm --prefix client run dev -- --host"
    }
  }
}
```

### Who runs where

The line is drawn by whose code it is, not by which feature asked:

- **A `ui_check` task** — a pull request's head, possibly a stranger's — brings its environment up
  **inside one disposable container**: `docker run --rm` of the repo's `image`, the worktree
  bind-mounted as the working directory, the environment exactly the declared `ui.env` (with the
  existing `${NAME}` pass-through) and nothing of the engine's, the app's port published on
  loopback so Playwright on the host reaches it. `prepare`, each service in order, then
  `devCommand` run inside that container. The head's `postinstall` scripts see a throwaway
  filesystem with one worktree in it — no `~/.claude`, no `~/.jarvis`, no engine `/proc`, no
  host-local Postgres.
- **A build task's UI check** (WRK-10, the owner's own repository and the worker's own branch)
  keeps today's `ProcessDevServer` host path unchanged. Moving it into the container too is
  allowed later, but it is not what this decision buys.

### Lifecycle: the lease stays, the pid file goes

The engine-wide single lease, the readiness timeout per step and the refusal reasons all stay as
they are in the `DevServerManager` port. What changes is the kill path: teardown is
`docker rm -f` of one container, and orphan recovery at engine start is
`docker ps --filter label=jarvis.task` instead of a pid file — the container is labelled with the
task id at launch. Readiness probes run from the host against the published port, replacing the
`until … sleep 1` loops of the shell string, with the existing per-step timeout. This also
retires the process-group bookkeeping the earlier draft got wrong: the container is the group.

### Implementation shape (the reviewer's findings, folded in)

- One pure resolver, `resolveUiEnvironment(ui, repoKey)`, returns the whole plan —
  `{image, env, prepare, services, devCommand, baseUrl, readyPath, allowedOrigins}` — and is the
  only reader of `ui.repos`. `ProcessDevServer`, the new `DockerDevServer` and `playwrightServer`
  in run-files all consume the plan, never `ui` directly. `DevServerManager.start()` therefore
  takes the task's repo identity, which `StartDevServer` already has.
- `DockerDevServer` is a second adapter behind the same port, chosen by task kind in the
  composition root. `ProcessDevServer` is not grown into a supervisor.
- The `FORBIDDEN_PATHS` guard on chat config edits walks nested paths, so `ui.repos.*.devCommand`,
  `*.env`, `*.image` and `*.prepare` are as uneditable from chat as their top-level namesakes.

### What this is and is not

This **is** a containment boundary for the head's running code: build scripts, services and the
application itself execute in a filesystem and pid namespace that dies with the check. It is
**not** a boundary around the worker agent, which still reads the head's files (`CLAUDE.md`
included) as instructions. That risk is bounded differently: the `ui_check` worker has no shell,
no editor and no token, so an injected instruction can at worst skew a report the owner reads
anyway. And the container's network is the default bridge: the head can still reach the internet
(it must — `npm ci`), so exfiltrating *what it can see* is not prevented; the point is that it
sees nothing worth taking.

### Why the others were rejected

- **(1) Host processes**: rebuilt the containment gap, and its group-management premise was
  factually wrong (see Context). What survives of it is the declaration format.
- **(2) Binary allow-list**: theatre — recorded here so it is not proposed again.
- **(3) `ui.env` + `prepare` only**: narrows the hand-over, does nothing about where code runs;
  already landed as an interim step and insufficient alone.
- **(4) The repo declares its own services**: a file in an untrusted head saying "to run me,
  execute this" is an instruction from the untrusted head (ADR-0017). The declaration lives in
  the owner's config. A repository Jarvis owns could be trusted with its own file later; that is
  a separate decision.
- **(6) Daytona / microVMs**: real isolation, disproportionate cost — new infrastructure, remote
  state sync, another credential to manage — for a single-owner box whose realistic threat is a
  malicious `postinstall` stealing tokens. Docker is already a hard dependency (Postgres, the
  runtime image, integration tests), so option 5 adds no new moving part.

### Consequences

- Good: what a check runs becomes a reviewable table — image, names, ports, probes — and the
  worst a stranger's `postinstall` can reach is a throwaway container with one worktree in it.
- Good: teardown and orphan recovery get simpler and cover every service, because the unit of
  cleanup is one labelled container, not N process groups.
- Good: identical on the laptop and the VPS; nothing new to install or pay for.
- Bad: a cold container re-downloads npm packages per check. Accepted at first; a named cache
  volume per repository is the known fix if it hurts.
- Bad: the engine needs the Docker socket at runtime even on the laptop path (`pnpm dev`), not
  only in compose. A missing daemon must refuse a `ui_check` with a clear reason, not hang.
- Neutral: secrets still must not appear in `ui.repos.*.env` (ADR-0015); `${NAME}` stays the
  deliberate pass-through, and the config paths are locked against chat edits.

## More Information

- Interim steps already landed and kept: the narrowed dev-server inheritance with declared
  `ui.env` (this record's option 3, as a stopgap), the disarmed `ui_check` worker (no Bash, no
  Edit, no `GH_TOKEN`, `--setting-sources user`, diff precomputed into `.jarvis/`), and the
  chat-edit lock on the `ui.*` attack-surface paths.
- The shared MongoDB binary cache (`MONGOMS_DOWNLOAD_DIR`) moves inside the container image or a
  cache volume; it remains a quick-blog detail, not part of this decision.
- Open: whether `prepare` results should be cached across checks of the same PR; whether a
  service that dies mid-check fails the check or is only reported; whether the container should
  get an explicit egress policy later (today: default bridge).
