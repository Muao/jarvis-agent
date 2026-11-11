---
status: accepted
date: 2026-11-11
decision-makers: [] # owner rulings 2026-11-10 (docs/specs/generic-engine-and-project-knowledge.md) and 2026-11-11 (the agent is repository-agnostic; the UI check is a step of the workflow); drafted by Claude
scope:
  [
    'shared/src/config.ts',
    'shared/src/environment-plan.ts',
    'shared/src/mcp.ts',
    'engine/src/application/ports/dev-server.ts',
    'engine/src/application/ui/start-dev-server.ts',
    'engine/src/application/tasks/open-pr.ts',
    'engine/src/infrastructure/dev-server/**',
    'engine/src/infrastructure/claude/run-files.ts',
    'agent/prompts/worker.md',
    'agent/skills/project-knowledge/SKILL.md',
    'jarvis.config.example.json',
  ]
supersedes: ['0019']
superseded-by: []
---

# ADR-0026: The engine knows no target project; the agent discovers how to run it

## Context and Problem Statement

`jarvis.config.json` carried one `ui` block for every repository: `ui.devCommand` pointed at a
hand-written script for one project, `ui.env` held that project's database URI and JWT secret.
A task on any other repository started the wrong project (T-3, 2026-11-10) and the worker could only
ask the owner to reconfigure the server. ADR-0019 (proposed) would have moved the same knowledge into
a `ui.repos[...]` block per repository — more of the thing that failed.

The owner ruled that nothing about a target project lives in the Jarvis repository or its config, and
that the UI check is a step of the workflow rather than an option.

## Decision Drivers

- A UI check on any allow-listed repository must work with no per-repository setup by the owner.
- A command chosen by a model must never run on the host with the engine's uid, environment or files.
- No credential of a target project is stored anywhere.
- No new dependency: the Docker CLI the deployment already has (ADR-0011, ADR-0016).

## Considered Options

1. Per-repository config (`ui.repos[...]`, ADR-0019).
2. The owner writes a run script per project under `~/.jarvis/`.
3. **The worker composes an environment plan at runtime; the engine runs it in disposable containers.**

## Decision Outcome

**Option 3.**

- **The plan** (`EnvironmentPlanSchema`): an image, `prepare` commands, services (its own container
  when it names an image, a background process next to the app otherwise), the app with its port and
  ready path, extra ports, and variables. The worker derives it from the repository's own files,
  guided by the `project-knowledge` skill, and passes it to `start_dev_server({plan})`.
- **Where it runs** (`DockerDevServer`): one network and a set of containers per check, labelled
  `jarvis.check`. The plan chooses images, commands, ports and variables; the engine sets everything
  else — no extra mounts, no capabilities, `no-new-privileges`, ports published on loopback only.
  The task's worktree is mounted read-only and copied inside, so a check can neither write into the
  worktree nor break the host-side checks with another platform's `node_modules`. The host-process
  `ProcessDevServer` is removed: there is one path for build tasks and `ui_check` tasks.
- **Credentials**: a secret is `{ "generate": true }`; the engine invents it per check, passes it to
  the containers through a short-lived env file and forgets it. Other values refer to it as
  `${NAME}`. A plan with a literal credential is refused (`invalid_plan`), which keeps a plan safe to
  journal. A value the browser must type (a seeded login) may be marked `reveal` and is returned to
  the worker with the lease; it is worth nothing once the containers are gone.
- **Ports**: published on the same numbers on `127.0.0.1`, because a client bundle carries the API's
  URL. A taken port is refused (`port_busy`) and the worker moves the project to another one.
  Playwright MCP starts before any plan exists, so its allow-list is "loopback, any port" with the
  engine's own API port on the block-list. As before, this is a brake, not a boundary.
- **Failure loop**: a refusal names the step, its exit code and the tail of its output; the worker
  may revise the plan up to `ui.maxStartAttempts` times per run.
- **Config**: `ui.devCommand`, `ui.baseUrl`, `ui.readyPath`, `ui.allowedOrigins`, `ui.env` are gone;
  `ui.defaultImage`, `ui.prepareTimeoutSeconds`, `ui.maxStartAttempts` are added. A file that still has
  the retired keys loads without them and says so.
- **The UI check is mandatory**: `ui.enabled` defaults to true, and `open_pr` refuses the first pull
  request of a task whose diff touches `ui.paths` until the journal shows an attempt
  (`ui_check_required`). A refused start counts as an attempt — the PR then says why the check did
  not complete. `start_dev_server` also works in `Fixing` and `PR Open`.

This amends ADR-0014: "no model picks the command" becomes "a model-picked command runs only inside
the disposable containers". ADR-0018's owner approval for an untrusted head is unchanged and now
shows the plan's commands.

### Consequences

- Good: a new repository needs nothing from the owner; the T-3 failure cannot recur.
- Good: a stranger's build scripts never see the engine's environment or files.
- Bad: every check pays for discovery and a cold install until project records exist (below).
- Bad: Docker is now required for any UI check; without a daemon the check is refused with
  `docker_unavailable`, not skipped silently.

### Not done here

- **Project records** (`~/.jarvis/projects/<owner>/<name>/PROJECT.md`, the plan that last worked,
  `read_project` / `update_project`, moving repo-scoped memory out of `USER.md`) — section 3 of the
  spec. Until then a plan is rediscovered on every check.
- **Egress filtering** of the check network (no RFC1918, no Tailscale range, no host addresses). It
  needs firewall rules on the host and is a server setup step, see `docs/architecture/deployment.md`.
- **Dependency caching** between checks.
- Renaming real repository names in test fixtures.

## More Information

Spec: `docs/specs/generic-engine-and-project-knowledge.md` (sections 1, 2, 5).
