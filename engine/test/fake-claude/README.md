# fake-claude

Stand-in for the `claude` binary in tests (ADR-0013). Plain Node, no dependencies; tests never run the real CLI.

`JARVIS_FAKE_SCENARIO=<name>` picks the scenario next to the script. A scenario is `{ "steps": [...] }`, played after
the first stdin message arrives. The file is the first that exists of `<name>.<role>.<stage>.json`,
`<name>.<role>.json`, `<name>.json`: the role is `dispatcher` when the argv has `--allowedTools`, else `worker`; the
stage is the `stage:` line of a worker's run context, lowercased with dashes (`implementing`, `spec-review`). This lets
one scenario name script a whole flow where each run needs different steps.

Step types: `init`, `text`, `thinking`, `tool_use` (with a canned result), `jarvis_tool` (real HTTP
`POST {JARVIS_API_URL}/api/agent/tools/<tool>` with the run token read from `--mcp-config`), `write_artifacts`
(`files` written into the `artifactsDir` of the run context), `echo_stdin` (waits for the next stdin message and
repeats it), `sleep`, `stderr`, `raw`, `result`, `exit` (ends the process without a result).
After the steps the process waits for stdin to end, like the real CLI in streaming-input mode.

Scenarios: `ok`, `tool-call`, `max-turns`, `crash`, `slow`, `echo`, and the `flow` set used by
`engine/test/flow/full-flow.int.test.ts` (`flow.dispatcher`, `flow.worker.context`, `flow.worker.implementing`).
`session_id` is `fake-session-1`, or the `--resume` value.
