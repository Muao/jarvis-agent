# Connectors: how Jarvis authenticates to external services

How the worker reaches Notion, Google Docs and other sources (CTX-02, CTX-03), and how that works on a
headless server (ADR-0015) with secrets in Infisical (ADR-0016). Status: decision taken 2026-11-08, implementation
planned in `../plans/server-readiness.md` (Task 2.6).

## How a connector is wired

The engine writes a `mcp.json` for every run from `~/.jarvis/mcp/servers.json`, substituting `${VAR}` with the
engine's environment, and starts `claude` with `--mcp-config <run>/mcp.json --strict-mcp-config`
(`engine/src/infrastructure/claude/run-files.ts`). Consequences:

- Claude Code's own MCP store and the OAuth tokens it keeps after `/mcp` are **not** used. Only servers listed in
  `servers.json` load.
- A connector's credential is whatever its variable holds. If the credential can be a secret in Infisical, the
  connector needs no interactive step on any machine.
- The engine cannot test a connector without a model run; `/api/connections` only reports whether the variables
  are set (`connector-probe.ts`). A bad credential surfaces when a worker reads the source (CTX-05: `Blocked`).

## Rule: one interactive login per machine, and it is `claude`

The only thing the owner does over SSH on the server is `claude` → `/login`. Every other service must be
reachable with a credential that lives in Infisical. Pick the authentication type in this order:

| Order | Type | Examples | Server work |
|---|---|---|---|
| 1 | Static token or service account | Notion internal integration token; Google service account key; GitHub PAT | none |
| 2 | OAuth done once on the laptop, refresh token stored in Infisical (**way 1**) | a Google MCP server that reads the token from env | none |
| 3 | OAuth done once on the server over an SSH tunnel, token on the server's disk (**way 2**, fallback) | a server that only stores its token in its own file | one SSH session |
| — | Remote MCP with OAuth through Claude Code (`/mcp`) | hosted Notion / Google MCP, claude.ai connectors | **not used on the server** |

## Way 1 (chosen): authorise on the laptop, keep the refresh token in Infisical

Preconditions: the MCP server accepts the refresh token (or the path of a token file) from an environment
variable, and the OAuth app is **In production** in Google Cloud. A Google OAuth app left in **Testing**
invalidates refresh tokens after 7 days, so the server would silently lose access weekly.

1. Create the OAuth client (type *Desktop app*) in the owner's Google Cloud project; publish the consent screen
   (internal use, no verification needed when only the owner's account uses it).
2. Run the server's authorisation once on the laptop; it opens the browser, the owner grants access, the server
   writes its token file.
3. Copy the refresh token (and client id/secret) into Infisical `dev` **and** `prod`; delete the local token
   file if the server can read the values from env; otherwise keep it under `~/.jarvis` on the laptop only.
4. Reference the variables in `~/.jarvis/mcp/servers.json` as `${GOOGLE_OAUTH_CLIENT_ID}`,
   `${GOOGLE_OAUTH_CLIENT_SECRET}`, `${GOOGLE_OAUTH_REFRESH_TOKEN}`.

The laptop and the server share one refresh token; Google allows that. Rotation: revoke the token in the Google
account, repeat steps 2–3, `systemctl restart jarvis-engine`.

Preferred over OAuth entirely: a **service account**. Its JSON key goes to Infisical (`GOOGLE_SERVICE_ACCOUNT_JSON`,
base64), the Drive folder is shared with the service account's e-mail as *Viewer*. No browser, no expiry, revoked
by deleting the key. Use it whenever the chosen Google MCP server supports it.

## Way 2 (fallback): authorise on the server through an SSH tunnel

For a server that stores its token only in its own file and cannot take it from env.

```sh
ssh -L <port>:127.0.0.1:<port> jarvis@<host>     # <port> = the callback port the MCP server prints
# on the server, as jarvis:
<mcp server's auth command>                      # prints an https://accounts.google.com/... URL
# open that URL in the laptop's browser, grant access; the redirect to localhost:<port> goes through the tunnel
chmod 600 <token file>
```

Security of this way, and why it is only the fallback:

- The callback listens on the server's `127.0.0.1`; only the one-time authorisation code crosses the SSH tunnel.
  The refresh token is fetched by the server over HTTPS. Nothing is exposed on a public interface.
- The token sits in plaintext on the server disk, like the `claude` login in `~/.claude`. Anyone with SSH as
  `jarvis` can use it: SSH stays key-only over Tailscale (ADR-0015).
- Hetzner snapshots include the file. Keep 2FA on the Hetzner account; after a suspected leak, revoke the app's
  access in the Google account, not just the file.
- Rotation means repeating the procedure instead of changing a value in Infisical. Record the exact commands in
  `deploy/README.md` when a connector uses this way.

## Not used on the server: Claude Code remote MCP OAuth

Tokens from `/mcp` live in `~/.claude` (Keychain on macOS, a file on Linux), expire quickly and are not read when
`--strict-mcp-config` points at Jarvis's `mcp.json`. Do not copy `~/.claude` between machines for this.

## Per connector

| Connector | Type | Variables | Scope control |
|---|---|---|---|
| Notion | internal integration token | `NOTION_TOKEN` | share only the root page (`connectors.notionRoot`) with the integration |
| Google Docs | service account (preferred) or way 1 | `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_OAUTH_*` | share only the folder (`connectors.googleFolder`) |
| GitHub | fine-grained PAT of the bot account | `GITHUB_TOKEN` | one repository |
| Claude Design | manual handoff in iteration 1 | — | — |
