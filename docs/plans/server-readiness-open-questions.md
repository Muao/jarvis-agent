# Server readiness: what is left

Companion to [`server-readiness.md`](server-readiness.md). All fifteen tasks of that plan are implemented and
committed on `docs/deployment-and-secrets`; this file is everything that is **not** done, so the work can continue
in a fresh session without this chat.

Written 2026-11-08, at branch head `1e1d65b` (30 commits over `main`).

State at that commit: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean; `pnpm test` green — 800 engine,
186 web, 57 shared. Task 4.4 (owner verdict on a task) was deliberately not implemented: the plan makes it
conditional on seeing the Usage page first.

---

## 1. Owner steps that nothing else can replace

### Gate 1 — the `claude` login inside the rehearsal container

The image is built and inspected: user `jarvis` (uid 1000), `HOME=/home/jarvis`, Node 22.23.4, pnpm 10.23.0,
`claude` 2.1.319, no `ANTHROPIC*` variable, every published port on `host_ip: 127.0.0.1`, and
`/home/jarvis/.jarvis/jarvis.config.json` already seeded in the `jarvis-home` volume with `repo.path=/work/repo`,
`claudeBinary: "claude"` and haiku models. What is missing is only the credential, and the macOS login lives in
the Keychain, so it cannot be copied in.

```sh
docker compose --profile server run --rm --no-deps engine claude   # then /login, paste the code, exit
```

Then the rest of Gate 1, which can be run by anyone (or by an agent) once the login exists:

```sh
docker compose --profile server run --rm --no-deps engine claude auth status --json
docker compose --profile server run --rm --no-deps engine ls -la /home/jarvis/.claude/.credentials.json  # expect mode 600
docker compose --profile server run --rm --no-deps engine claude -p "ping"
docker compose --profile server up -d
curl -s http://127.0.0.1:4310/api/health
# then open http://127.0.0.1:5180 and send a message; a dispatcher run must answer
```

Note while doing this: the `web` container shares the engine's network namespace, so recreating the engine
container leaves `web` attached to a dead namespace until it is recreated too.

### Git history was rewritten — any other clone must be reset

On 2026-11-08 every commit on `main`, `docs/github-pages` and `docs/deployment-and-secrets` was re-authored to
the personal address (the work account's e-mail had been the git identity) and force-pushed. Shas changed.

- **A clone that fetched the old commits will break on `git pull`.** Fix it with
  `git fetch origin && git reset --hard origin/<branch>`. This applies to the VPS checkout.
- The local repository still holds the pre-rewrite objects in `.git/refs/original` and the reflog. Purging them is
  irreversible and was left to the owner:
  `rm -rf .git/refs/original && git reflog expire --expire=now --all && git gc --prune=now`
- A force-push does not delete old objects on GitHub immediately: the old shas may stay reachable by direct
  reference until GitHub's own garbage collection runs. If that matters, the robust answers are recreating the
  repository or asking GitHub support.
- `git config --global user.email` is still the work address by the owner's choice, so **every new personal
  repository needs `git config user.email` set locally right after `git init`**, or its first commit carries the
  work identity again.

### Merging

The owner chose commits on this branch with no PR, so the merge into `main` is a local decision that has not been
made yet.

---

## 2. Findings from the final whole-branch review

Verdict: **merge after fixes** — four Important, no Critical. The four cross-cutting seams were traced end to end
and hold (the probe cache and its single producer, the expired-login run gate, the `event` vocabulary, and the
`telemetry` path into a child's environment), as do all five of the plan's Review Focus invariants, and every
credential was traced for exposure through logs, argv, committed files, child processes and error messages.

### Important 1 — `stopReason` is in the log contract but no producer writes it

- `engine/src/application/ports/logger.ts:6` lists `stopReason` among the fixed context keys (the contract with
  the log pipeline, ADR-0018), but `engine/src/application/runs/run-sink.ts:86-99` writes `run.finished` with
  `runId, sessionId, taskId, threadId, role, costUsd, turns, durationMs` and no `stopReason`. Task 4.1 added
  `runs.stop_reason` to the schema, the domain, the DTO and the Usage page, but did not close this seam.
- **The producer should move, not the contract.** `stopReason` is the whole reason ADR-0018 wants structured logs
  — "why did it go badly" without reading `run_events` — and the value is already on the `run` object in that
  exact line of code.
- The fix, one line in `run-sink.ts`'s `run.finished` context:

  ```ts
  ...(run.stopReason === null ? {} : { stopReason: run.stopReason }),
  ```

- Strictly, `config.alloy` and the dashboard need no change: the field rides along in the JSON line and
  `{unit="jarvis-engine.service", event="run.finished"} | json | stopReason="max_turns"` works as is. Optionally,
  add `stopReason = "stopReason"` to `stage.json.expressions` and `stopReason = ""` to `stage.labels.values` in
  `deploy/alloy/config.alloy` — seven possible values, so it is safe as a label and turns "which runs went badly"
  into a selector rather than a line filter.
- **Two statements become false once this is fixed and must be updated in the same change:**
  `deploy/alloy/README.md` ("`stopReason` is not logged yet (a later task). No panel needs it…") and the
  "UNVERIFIED until Gate 3" markdown panel in `deploy/grafana/jarvis-overview.json`.

### Important 2 — a Grafana credential the instructions create and nothing reads

- `.env.example:27` asks the owner to fill in `OTEL_EXPORTER_OTLP_HEADERS`; ADR-0018:41 confirms it ("live in
  `~/.jarvis/.env` or Infisical"); `deployment.md` §3 says to put "variables as in `.env.example`" into Infisical
  `prod`. **Nothing reads it.** Alloy authenticates with `GRAFANA_LOKI_URL`, `GRAFANA_LOKI_USER`,
  `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_USER` and `GRAFANA_CLOUD_TOKEN` (`deploy/alloy/config.alloy:77-116`, and
  the table in `deploy/alloy/README.md:18-22`); the engine never consumes it; a child never receives it, which is
  pinned by `env.test.ts:133`.
- Why it matters: following the instructions puts a Grafana Cloud token into the engine process's environment for
  no purpose, where a child `claude` can read it through `/proc/<engine>/environ`. It is a **new instance** of the
  accepted `/proc` risk, and the only place in the branch that adds a path to a credential with no need for it.
- Fix: remove the line from `.env.example` (or comment it out saying the credentials live only in
  `/etc/jarvis/alloy.env` and that Alloy reads `GRAFANA_*`), and rewrite the ADR-0018:41 bullet to name the five
  real `GRAFANA_*` variables instead of `OTEL_EXPORTER_OTLP_HEADERS`.

### Important 3 — `ExecStartPost` contradicts the "Postgres down" invariant

- `deploy/systemd/jarvis-engine.service:14` runs `curl -fsS http://127.0.0.1:4310/api/health`, and `-f` treats a
  503 as failure. But 503 is exactly "Postgres is down, the engine is alive" — the behaviour Review Focus #2
  protects and which was verified live.
- If Postgres has not come up (and `After=docker.service` does not guarantee it, as `deploy/README.md:60` itself
  admits), the unit loops about every 68 seconds: the engine starts, answers 503 honestly for 60 seconds, systemd
  kills it, `RestartSec=5`, again. The default `StartLimitBurst` never trips (it needs 5 starts in 10 seconds), so
  the loop does not stop.
- Why it matters: `deploy/README.md:60` claims "`Restart=on-failure` covers that gap", but the loop does not close
  it — it hides the real cause and makes journald unreadable at exactly the moment someone is reading it, which
  breaks the one answer ("is it alive") this branch exists to provide.
- Fix, any one of: (a) accept both 200 and 503 — `curl -sS -o /dev/null -w '%{http_code}'` checked against
  `200|503`; (b) add a real dependency on the Postgres unit or container; (c) drop `ExecStartPost` and rely on the
  heartbeat. Correct `deploy/README.md:60` in the same change.

### Important 4 — the observability half is unreachable from the runbook

- `grep -rn "alloy\|Alloy\|telemetry\|heartbeat\|healthchecks" docs/architecture/deployment.md README.md
  docs/architecture/README.md` returns **zero hits**. The file table in `deploy/README.md:6-10` lists only the two
  units and `../scripts/with-secrets.sh`, and mentions neither `alloy/` nor `grafana/`.
- Why it matters: an operator who follows `deployment.md` from §1 to §6 — the only complete runbook — ends up with
  a server with no Alloy, no `HEARTBEAT_URL` and no telemetry, that is, without either of the two answers the
  branch was built for. ADR-0018 is implemented in `deploy/` but not wired into the deployment process.
- Fix (minimal sufficient): a §4a "Telemetry and liveness" in `deployment.md` — three or four lines pointing at
  `deploy/alloy/README.md` and naming `HEARTBEAT_URL` and `telemetry.enabled` — plus two rows in
  `deploy/README.md`'s table for `alloy/` and `grafana/`.

### The reviewer's own must-fix list, in order

Everything else it judged safe to carry.

1. **Important 1** — `stopReason` on `run.finished`, plus removing the two "not logged yet" statements.
2. **Important 2** — the dead `OTEL_EXPORTER_OTLP_HEADERS` line and the ADR-0018:41 sentence.
3. **Important 4**, minimal scope — two rows in `deploy/README.md`'s table and a pointer from `deployment.md` to
   `deploy/alloy/README.md`.
4. **Important 3** — the reviewer would have fixed it immediately with option (a), about five minutes' work, but
   accepted it as a recorded follow-up with one condition: **before the first `systemctl enable`.** Nothing else
   on this page carries a deadline like that.

### Triage of the deferred minors

Three of the eleven are **already closed on the branch** and should simply be struck from the register, not fixed:

- `container.ts`'s stale comment and the `LISTEN_HOST` naming — already renamed to `LOOPBACK_HOST` and the comment
  corrected (`container.ts:72`, `server.ts:15`).
- The healthcheck and README `curl` on `/api/overview` — both now `/api/health` (`compose.yaml:49`, `README.md:73`).
- `network_mode: service:engine` being brittle — the README already says so; only the optional part (restoring a
  separate network when `web/vite.config.ts` is next touched) remains.

The remaining eight were all triaged **defer**, with these reasons:

| Minor | Why it can wait |
|---|---|
| Unpinned `ubuntu:24.04`, `curl \| bash` installs, unused `gnupg` | The image is a rehearsal, not a deployment target (ADR-0017), and pinning by digest would break rebuilds when the base updates. |
| No test that `listen()` uses `env.listenHost` | The path was verified live in the container (`host_ip: 127.0.0.1` plus a working `/api/health`), and the type is held by typecheck. |
| `JARVIS_INSIDE_CONTAINER=1` defeating the guard on a host | That is the brief's design, not a defect: the guard is against a mistake, not against the owner. |
| The `INFISICAL_API_URL` comment, PATH only in `deploy/README.md`, the fallback stderr line | All three are covered by the "Not verified yet" section, and the Infisical path has to be walked by hand at first run anyway. |
| No test that `startTimers` starts and stops the probe-refresh job | The watcher and supervision timers have the same gap — a pre-existing pattern, not a regression of this branch. |
| The pool piling up pings under a hung Postgres | A pool-level change (`connectionTimeoutMillis`, `statement_timeout`) outside the task; no server exists yet, so the exposure window is zero. **Worth being the first follow-up before the first unattended run.** |
| Stale `summary`/`checkedAt` on a kept cache entry | Nothing consumes those fields from `last()` — `Health` does not carry them and `/api/connections` takes a fresh `check()` — so there is no observable effect today. |
| `permission.answered` not distinguishing a timeout from an orphaned run | Same category as Important 1 (widening the log context); the status in the message text already distinguishes them. Sensible to do together with `stopReason` while that contract is open. |

---

## 3. Deferred minors carried from the task reviews

Each was raised by a reviewer and consciously not blocked on.

| Area | Item |
|---|---|
| Runtime image | `network_mode: service:engine` is brittle: recreating the engine container leaves `web` without a network until it is recreated too. The README should say so, and a task that touches `web/vite.config.ts` should restore a separate network. |
| Runtime image | `ubuntu:24.04` is not pinned by digest; NodeSource and `claude.ai/install.sh` are `curl \| bash` with no pinned version; `gnupg` is installed but unused. |
| Engine config | No test asserts that `listen()` actually uses `env.listenHost` — only `loadEnv` is covered. |
| Engine config | `JARVIS_INSIDE_CONTAINER=1` left in a host shell alongside a non-loopback host defeats the loopback guard. This follows from the design, not a defect. |
| Deploy docs | The `with-secrets.sh` comment mentions `INFISICAL_API_URL` for a non-US host, which is unverified; the PATH requirement lives only in `deploy/README.md`, not in `deployment.md` §4; the fallback stderr line prints on every laptop invocation. |
| Health | Nothing tests that `startTimers` starts and stops the probe-refresh job — the watcher and supervision timers have the same gap, so it is a pre-existing pattern. |
| Health | Under a hung Postgres, every `/api/health` call starts a ping the pool never releases, so requests can pile up in the pool queue. Consider `connectionTimeoutMillis` and `statement_timeout` on the pool. |
| Health | When the cache keeps a previous entry because the CLI did not answer, that entry's `summary` and `checkedAt` grow stale. |
| Logging | `permission.answered` is also logged for the orphaned path (`reason: 'run_ended'`), and the reason is not in the line, so a timeout and an orphaned run differ only by status text. |
| Heartbeat | No test covers `stop()` while a `fetch` hangs beyond its 5-second abort. |
| Connectors | `.env.example` names `GOOGLE_APPLICATION_CREDENTIALS` where the plan said `GOOGLE_SERVICE_ACCOUNT_JSON`; the former is correct for the chosen server (it reads a file path, not JSON). |

---

## 4. Never executed, by necessity

Nothing below was verifiable on the laptop, and each is stated in its own README too.

- **Alloy**: `deploy/alloy/config.alloy` has never been run; `alloy fmt` and `alloy validate` were unavailable.
  The Loki queries in `deploy/grafana/jarvis-overview.json` are likewise unexercised.
- **Claude Code metric names** (for example `claude_code_token_usage_tokens_total`) come from the CLI's
  "Monitoring usage" documentation, not from an observed export. The dashboard says so on its first panel.
  (The `modelUsage` **field** names were separately verified against CLI 2.1.318 on 2026-11-08 and are correct:
  `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`.)
- **The Alloy service user**: the credential file is specified as `/etc/jarvis/alloy.env`, `root:alloy`, mode
  `0640`. Which user the distribution's Alloy package runs as was not confirmed; `deploy/alloy/README.md` says how
  to check. If only systemd reads the file, `root:root 0600` would be stricter and sufficient.
- **The Infisical branch of `scripts/with-secrets.sh`**: the CLI is not installed locally, so only the fallback
  path (no `INFISICAL_CLIENT_ID` → plain `exec`) was executed. The flags `--method=universal-auth`, `--silent`,
  `--plain` and the variable names come from knowledge of the CLI, not from a run.
- **The systemd units**: never loaded. `ExecStartPost` curls `/api/health`, which only exists from this branch on.
- **The Google connector**: no Google Cloud project, no token, nothing authorised. Four items are listed in
  `docs/architecture/connectors.md` under "verify at first setup", including whether a service account can read a
  personal (non-Workspace) account's Doc, whether `drive.readonly` alone suffices for the Docs API, whether
  publishing the consent screen needs verification for these scopes, and how the `auth` command receives the
  client id and secret.
- **The e2e suite** (`pnpm --filter @jarvis/web e2e`) was not run at any point in this work.

---

## 5. Decisions taken on the owner's behalf that are worth a second look

Thirty-eight rulings were recorded while executing the plan. These are the ones whose cost, if wrong, is not
merely cosmetic:

1. **A child `claude` can read the engine's secrets through `/proc`.** It runs as the same user as the engine, so
   the `child-env.ts` allow-list protects inheritance but not a sibling read — including `INFISICAL_TOKEN` and
   `GITHUB_TOKEN`. Accepted and documented (`deploy/README.md`, ADR-0016 Consequences). The real fix is running
   child processes under a separate uid, which touches ADR-0007, the worktree permissions and `~/.claude`, and is
   its own task.
2. **The Google token must be minted read-only on the laptop.** `GOOGLE_DRIVE_MCP_SCOPES` does nothing in
   external-token mode, and the server's defaults grant **write** access to Drive, Docs, Sheets, Slides and
   Calendar. `connectors.md` step 2 carries the warning and the exact command. If the token is ever re-minted
   carelessly, a run can modify the owner's whole Drive.
3. **The run gate opens between probe ticks.** The expired-login gate reads a cache refreshed every five minutes,
   and before the first refresh the cache is empty, so the gate is open. Inherent to a cached probe.
4. **Day buckets are UTC, the budget resets at local midnight.** `/api/usage` groups by UTC day while
   `dailyBudgetUsd` uses `startOfLocalDay`, so the two "today" numbers legitimately differ. The Usage page labels
   it; nothing reconciles them.
5. **`stop_reason` is derived from the result `subtype`, not from the CLI's own `terminal_reason`.** Note that the
   CLI's top-level `stop_reason` is the **model's** API stop reason (`end_turn`), a different concept that shares
   the name; `terminal_reason` is its run-level one. If the mapping ever moves to `terminal_reason`, the column's
   values change meaning once.
6. **Fastify's request log is separate from `JARVIS_LOG_LEVEL`**, which drives the application's lifecycle lines;
   only `error` maps through. `info` in pino would mean two lines per HTTP request from a polling SPA.
7. **The Grafana dashboard's "engine up" panel is a proxy** — the age of the newest engine log line — because the
   engine logs only heartbeat *failures*. A healthy but idle engine looks stale there; healthchecks.io is the real
   liveness signal.

The full list, with the reasoning and the stated cost of each being wrong, is in the execution ledger at
`.superpowers/sdd/server-readiness/progress.md` (git-ignored, local to the machine this ran on). That file also
holds every task's implementer report path and the pre-flight conflict scan.
