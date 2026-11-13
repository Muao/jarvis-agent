# Codex mandatory UI verification

Status: approved for T-6 implementation.

## Outcome
A Codex build worker starts an engine-owned disposable environment, checks acceptance scenarios through a real browser, releases resources and submits a structured result. A mandatory UI check is satisfied only by a confirmed passing result for the commit being published.

Reuse EnvironmentPlan, DockerDevServer, authenticated tool API, pinned Playwright MCP and existing browser restrictions. No new dependency. Amend ADR-0026's attempt-only gate, ADR-0014's Claude-only tester rule and ADR-0029's capability description. The stronger publication gate is shared engine behavior; update the Claude reporting path for compatibility.

## Server and browser contracts
- Expose existing start_dev_server({plan}) and stop_dev_server({}) to Codex build workers with existing role/stage/trust/attempt guards. Derive plans from repository sources; do not run application commands directly on the host.
- Before checking, commit changes and require a clean worktree. Associate startup with an engine-generated checkId, authenticated run/task and engine-read HEAD SHA. Return checkId alongside the existing lease/baseUrl/origins/expiry. Keep refusal reason/detail/step/exitCode.
- Add a run-scoped stdio MCP client bridge using the existing SDK. Lazily launch the existing pinned Playwright MCP configuration, list its tools and expose approved tools through the authenticated ui_browser dynamic tool gateway. Reuse isolated profile, sanitized environment, artifact directory and protected origins. Browser calls require a matching active lease/check. Arbitrary JavaScript stays denied.
- Preserve browser tool errors and usable screenshot evidence; do not stringify away image content. If the protocol cannot deliver evidence, report unavailable. Refresh tool availability on resume/fork or safely create a fresh usable thread.
- Codex itself drives UI scenarios from the approved specification; no separate subagent is required. Record expected/observed outcomes and evidence. Close browser and stop server on every outcome; engine/adapter finalization remains the fallback.

## Explicit result
Add authenticated worker tool report_ui_check with strict bounded input:
- checkId: required for passed/failed; optional for unavailable before startup succeeds.
- status: passed | failed | unavailable.
- summary: nonempty text.
- scenarios: list of {criterion, expected, observed, status: passed | failed, evidence: task-relative artifact paths}.
- reason: required for unavailable, identifying startup/browser/timeout/protocol/cancellation/cleanup inability.

Engine derives taskId/runId/headSha/timestamp and journals ui_check_completed. Validate role, stage, check ownership, current clean HEAD and engine-observed browser activity. Passing requires a successful environment, at least one executed scenario, all scenarios passing, valid nonempty evidence and confirmed cleanup. Evidence paths must exist inside task artifacts after symlink resolution. Do not persist generated credentials in evidence or logs.

Return {ok:true, checkId, status, headSha} on acceptance; invalid/stale/wrong-owner reports return a clear refusal and create no pass. Identical repeated completion is idempotent; a closed failed/unavailable attempt cannot be rewritten to passed. A retry gets a new checkId. Failed assertions are failed; inability to inspect is unavailable. Neither is success. The worker assesses coverage of approved criteria; activity/evidence validation cannot independently prove semantic correctness of every assertion.

## Publication policy
For ui.enabled=true and a diff matching ui.paths, open_pr requires the latest applicable completed check for current HEAD to be passed, both for first publication and subsequent fixes. A server start/refusal, old commit, unavailable browser, failed assertion, unverified cleanup or missing result cannot satisfy this gate. Keep actionable ui_check_required refusal with latest verdict/reason. Preserve the existing final HEAD/tree recheck before pushing. ui.enabled=false remains explicitly disabled and must never be described as passed. Non-UI changes retain existing behavior.

## Cleanup
Engine owns containers/network/lease timer; The run-scoped infrastructure adapter owns browser MCP child/client/profile behind the engine gateway. Close in finally on completion, exception, timeout, owner stop and CLI exit. Drain or cancel pending startup/browser calls before teardown so late completion cannot leak resources or record a pass after run revocation. Stop only the relevant task lease. Attempt remaining cleanup when one operation fails, surface errors and prohibit a passing result on cleanup failure. Preserve expiry, shutdown and orphan recovery. Bound browser termination and do not kill unrelated processes. Keep evidence after cleanup.

## Acceptance criteria
1. Codex workers can start, browse, stop and report; dispatcher cannot report. Resumed sessions have usable tools.
2. A real browser fixture scenario creates evidence and a passed result bound to the checked commit; owned resources are released.
3. Assertion failures produce failed. Missing Docker/browser, launch/protocol errors and timeouts produce unavailable. Neither permits mandatory publication.
4. Startup alone, fabricated/missing evidence, no browser activity, stale HEAD, dirty worktree and wrong task/run cannot produce an accepted pass.
5. A new commit invalidates a previous pass. Follow-up PR updates require a matching pass. Non-UI and explicitly disabled cases retain coverage.
6. Tests exercise normal exit, partial startup failure, cancellation during pending startup, browser exception, CLI crash, timeout, explicit stop, lease expiry and shutdown/recovery. Cleanup failures remain visible.
7. Shared schema, engine/API and Codex regression tests cover these rules; Claude uses the same explicit reporting contract.

## Scope limits
No standalone ui_check tasks, new browser vendor, dependency upgrade, screenshot upload expansion, database migration, UI redesign or CI infrastructure work. Record real Docker/browser smoke evidence separately from unit checks. If runtime is unavailable, report the blocker without claiming success.
