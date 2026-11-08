# Alloy and the Grafana dashboard

One Grafana Alloy agent on the VPS (ADR-0018). It reads the journald units `jarvis-engine.service` and
`jarvis-web.service` and receives Claude Code's OTLP on `127.0.0.1:4318` (loopback only, ADR-0015), and forwards both to
Grafana Cloud. Postgres, not Grafana, is the source of truth for cost and budgets.

| File                              | Purpose             |
| --------------------------------- | ------------------- |
| `config.alloy`                    | The pipeline        |
| `../grafana/jarvis-overview.json` | Dashboard to import |

## Grafana Cloud: what you need

From the stack's details page (**Grafana Cloud portal → your stack → Details**):

| Env var                 | Where it is called in the UI                                                     |
| ----------------------- | -------------------------------------------------------------------------------- |
| `GRAFANA_LOKI_URL`      | Loki → "URL", with the path `/loki/api/v1/push`                                  |
| `GRAFANA_LOKI_USER`     | Loki → "User" (a number)                                                         |
| `GRAFANA_OTLP_ENDPOINT` | OpenTelemetry → "OTLP Endpoint" (`https://otlp-gateway-<zone>.grafana.net/otlp`) |
| `GRAFANA_OTLP_USER`     | OpenTelemetry → "Instance ID" (a number)                                         |
| `GRAFANA_CLOUD_TOKEN`   | A token, see below                                                               |

Token: **Administration → Users and access → Cloud access policies → Create access policy**, scopes `logs:write` and
`metrics:write`, then **Add token** on that policy. Name it for the host. The token is shown once. Nothing else is
needed: no traces, no read scope.

## Install on Ubuntu 24.04

Grafana's APT repository (check the current instructions at grafana.com/docs/alloy before running):

```sh
sudo mkdir -p /etc/apt/keyrings
wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor | sudo tee /etc/apt/keyrings/grafana.gpg > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" | sudo tee /etc/apt/sources.list.d/grafana.list
sudo apt-get update && sudo apt-get install alloy
```

### Which user does Alloy run as?

The credential file must be group-owned by the user the package's unit runs as. Do not assume the name; confirm it:

```sh
systemctl cat alloy | grep -E '^(User|Group|EnvironmentFile)='
id alloy
```

The rest of this page says `alloy`; substitute what you see. Alloy also has to read the journal:
`sudo usermod -aG systemd-journal alloy` (skip if `id alloy` already lists it).

### Credentials

`/etc/jarvis/alloy.env`, owner `root`, group the Alloy user, mode `0640`. Never group `jarvis`: `jarvis` is the engine's
user and also runs `claude`, so a group-readable file would hand Grafana Cloud credentials to any run.

```sh
sudo install -m 0640 -o root -g alloy /dev/null /etc/jarvis/alloy.env
sudoedit /etc/jarvis/alloy.env     # the five variables above, KEY=value, one per line
stat -c '%a %U:%G' /etc/jarvis/alloy.env     # 640 root:alloy
id -nG jarvis | grep -wc alloy               # 0
```

Make the unit load it with a drop-in (`sudo systemctl edit alloy`):

```ini
[Service]
EnvironmentFile=/etc/jarvis/alloy.env
```

### Config

```sh
sudo cp deploy/alloy/config.alloy /etc/alloy/config.alloy
alloy validate /etc/alloy/config.alloy    # see "Not verified yet"
sudo systemctl enable --now alloy
sudo systemctl status alloy --no-pager | head
ss -ltn | grep 4318      # must show 127.0.0.1:4318, never 0.0.0.0 or [::]
```

Then turn on `"telemetry": { "enabled": true }` in `~/.jarvis/jarvis.config.json` and restart the engine.

## Import the dashboard

Grafana → **Dashboards → New → Import → Upload JSON file** → `deploy/grafana/jarvis-overview.json`; pick the Loki and
Prometheus data sources of the Cloud stack when asked. The `dailyBudgetUsd` variable defaults to `20`; keep it equal to
`dailyBudgetUsd` in `jarvis.config.json`.

`stopReason` is not logged yet (a later task). No panel needs it; any panel you add for it stays empty until then.

## Not verified yet

Nothing here has been executed. Alloy is not installed on the machine this was written on, there is no Grafana Cloud
account, and no Claude Code run has ever exported OTLP.

- `config.alloy` was **not** run through `alloy fmt` or `alloy validate`. Block and argument names (`loki.source.journal`
  `matches`, `stage.structured_metadata`, `otelcol.auth.basic`, `sys.env`, `constants.hostname`) are from memory of the
  Alloy reference; run `alloy validate` first and fix what it reports.
- Whether the engine's JSON lines really reach Loki with the `event`, `level` and `role` labels.
- Claude Code's metric and log names. The dashboard uses `claude_code_token_usage_tokens_total`, a `tool_result` event with
  `success=false`, and a text match for rate limits. The names come from the CLI's "Monitoring usage" documentation
  (ADR-0018 risk) and the OTLP-to-Prometheus name translation in Grafana Cloud is a guess. Check against the installed
  CLI (2.1.318 on the laptop, and the server's version). The dashboard says so in its first panel.
- The "engine up" panel is a proxy: the engine logs no heartbeat success, so it shows the age of the newest engine line.
  healthchecks.io is the liveness signal.
- That `jarvis.run_id` is queryable on metrics: Grafana Cloud may keep resource attributes only in `target_info`.
- The systemd drop-in and the package's user name.

Gate 3 verifies it: Alloy running locally (`brew install grafana/grafana/alloy`), `telemetry.enabled: true`, one
`--model haiku` run, and in Grafana Explore the metrics with `jarvis.run_id` and the log line `run.finished`.
