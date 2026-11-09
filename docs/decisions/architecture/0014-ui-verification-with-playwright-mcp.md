---
status: accepted
date: 2026-11-08
decision-makers: ["Ivan Lapa"] # owner: a ui-tester subagent on sonnet, scenarios from spec.md, works on laptop and server; screenshots inline in the PR body, not a Jarvis gallery (2026-11-08); drafted by Claude
scope:
  [
    'agent/agents/ui-tester.md',
    'agent/prompts/worker.md',
    'shared/src/config.ts',
    'shared/src/mcp.ts',
    'engine/src/application/ui/**',
    'engine/src/application/ports/dev-server.ts',
    'engine/src/application/ports/code-host.ts',
    'engine/src/application/ports/artifact-store.ts',
    'engine/src/infrastructure/dev-server/**',
    'engine/src/infrastructure/claude/**',
    'engine/src/infrastructure/github/**',
    'engine/src/infrastructure/artifacts/**',
    'docker/runtime/Dockerfile',
    'jarvis.config*.json',
  ]
supersedes: []
superseded-by: []
---

# ADR-0014: Verify a UI change in a real browser through Playwright MCP, and put the evidence inline in the PR through GitHub's `user-attachments` upload

One record for the whole UI check: who drives the browser, who owns the dev server, and how the
screenshots reach the reviewer. (It merges the browser-check and screenshot decisions, drafted
together and never committed separately.)

## Context and Problem Statement

A worker takes a change to a draft PR on the strength of the target repository's own checks. For a UI
change that is weak evidence: a suite can be green while the button does not click or the layout has
collapsed. WRK-10 already specifies browser verification, conditional on "if a browser tool is
available" — and none existed. Giving an agent a browser raises two harder problems: a browsing loop
has no natural floor, and a dev server started by the agent through `Bash` survives the run, holds the
port and is invisible to the engine. Finally, screenshots are only worth taking if the owner sees them
where they review — in the PR — and GitHub has no documented API for attachments; in a private
repository an image committed to a branch renders as a broken image, not a picture.

## Considered Options

- Keep WRK-10 unsatisfiable (status quo); Playwright MCP given to the worker directly; **a `ui-tester`
  subagent plus an engine-owned dev server**; a new `UI Check` task stage.
- For the screenshots: commit them into the branch; a side branch with raw URLs; **the undocumented
  `user-attachments` upload**; a gallery in Jarvis's own web UI linked from the PR.

## Decision Outcome

### 1. A `ui-tester` subagent drives the browser; the engine owns the dev server

- **`agent/agents/ui-tester.md`**, `model: sonnet`, tools `Read, Glob, Grep` plus the browser. No
  `Bash`, no `Edit`, no `Write`: it looks and reports (`pass` / `fail` / `inconclusive`, a result per
  scenario with a screenshot, findings). The browsing stays out of the context of the run that then
  writes the PR.
- **Scenarios come from `spec.md`'s acceptance criteria**, not the model's imagination — that is what
  makes the check terminate.
- **`ui.devCommand` is config, never an argument.** `start_dev_server` / `stop_dev_server` take a
  strictly empty object. The engine runs the command in the task's worktree as a detached process
  group, waits for `ui.readyPath`, holds **one lease engine-wide** (`ui.leaseMinutes`), and kills the
  group on lease expiry, run end, shutdown, and on finding an orphan at start-up.
- **Brakes, not boundaries:** `--allowed-origins` is set to the dev server's origin plus whatever
  `ui.allowedOrigins` declares, because an application with a back end is more than one origin
  (Playwright's own help says this is not a security boundary); `browser_evaluate` and
  `browser_run_code_unsafe` are **denied**, because they let the agent satisfy a scenario by calling
  the click handler directly; `--no-webmcp` stops a page registering tools (SOUL principle 4).

  `browser_file_upload` was denied here too, on the grounds that a UI check does not need it. That
  was wrong and is reversed (2026-11-09). Choosing a file is something a person does in a form, so a
  cover image, an avatar or an import was simply unreachable, and a check of "create an article"
  ended up recreating the record through the API — which proves nothing about the form (T-6 on
  `burnjohn/quick-blog#38`). The line that matters is **"did the user interface do it"**, not "is
  the tool powerful": reaching past the interface stays denied, acting through it does not.
- **Pinned version** `@playwright/mcp@0.0.84`; Chromium ships in `docker/runtime` under
  `/ms-playwright` with `PLAYWRIGHT_BROWSERS_PATH` in the child env; `ui.noSandbox` adds
  `--no-sandbox` for the container.
- **A UI blocker reuses `limits.reviewRounds`** (the check sits inside `Reviewing`); no new counter, no
  migration. **`ui.enabled` defaults to `false`**, and the run context tells the worker
  `uiCheck: available` / `disabled: <reason>` so it never has to guess.

### 2. Screenshots go inline into the PR body through `uploads.github.com/user-attachments`

Chosen because it is the only option that renders inline in a private repository, and inline is the
point: a link the reviewer has to open is not evidence they will look at.

- One request: `POST https://uploads.github.com/user-attachments/assets?name=&content_type=&repository_id=`
  with a bearer token and raw bytes; `repository_id` from `GET /repos/{owner}/{repo}`, cached per
  process. The returned URL goes into the PR body as markdown; assets are tied to the repository, so
  they survive a PR being closed and reopened.
- **Behind `CodeHost.uploadAttachment`** — one adapter, tested against a fake `fetch`; when GitHub
  changes the endpoint, one file changes.
- **Failure is a value:** `attach_image` answers `{ ok: false, reason }` on 401/403/404/410/5xx, and
  the worker then writes the file name as plain text in the PR instead of a broken image.
- **The agent never handles the token or the request.** It calls `attach_image` with a path relative to
  its artifacts directory; the engine resolves it, refuses anything leaving the directory (checked
  after resolving symlinks), anything that is not an image, empty files, files over `ui.maxImageMb`,
  and stops at `ui.maxScreenshots` per task.
- **`ui.attachToPr: false`** turns the upload off without turning the UI check off — the escape hatch
  if the endpoint starts refusing our token.

## Consequences

- Good: a UI PR carries evidence a person can look at, in the place they already review, and the brakes
  are enforced by the engine and the CLI rather than the model's willingness to stop.
- Good: the dev server is a process the engine starts, leases and kills, like the worktrees; the whole
  undocumented GitHub surface is one method with one tested fallback.
- Bad: the runtime image grows ~400 MB; `ui.devCommand` is global while a task may target another repo
  (ADR-0012) — the owner edits the config to switch; a cold `npx` fetch of Playwright MCP needs the npm
  registry (an offline host reports `inconclusive`, not a silent pass); vendoring it is the open
  follow-up.
- Bad: an undocumented endpoint can change or start refusing tokens without notice, and **whether it
  accepts a fine-grained PAT is unverified** — it must be tried on a real PR before the feature is
  trusted; if it refuses, the choice is a classic PAT or `ui.attachToPr: false`.

## More Information

- `docs/specs/ui-verification.md` — the feature spec, its acceptance criteria, and the open question.
- [Programmatically upload attachments to GitHub Issues, Pull Requests, and Comments](https://island94.org/2026/08/programmatically-upload-attachments-to-github-issues-pull-requests-comments)
- [Comment API for uploading images/attachments · community discussion #28219](https://github.com/orgs/community/discussions/28219)
- `npx @playwright/mcp@0.0.84 --help` and its `tools/list`, read on 2026-11-08.
