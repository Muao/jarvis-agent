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
4. Reference the variables in `~/.jarvis/mcp/servers.json` as `${VAR}` for each variable the server
   reads (for Google Docs: see "Per connector" below).

The laptop and the server share one refresh token; Google allows that. Rotation: revoke the token in the Google
account, repeat steps 2–3, `systemctl restart jarvis-engine`.

Preferred over OAuth entirely, when the server can read it from a variable: a **service account** (key in
Infisical, Drive folder shared with its e-mail as *Viewer*; no browser, no expiry). The chosen Google Docs server
cannot (see "Per connector"), so Google Docs uses way 1.

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
| Google Docs | way 1: OAuth refresh token from env (see below) | `GOOGLE_DRIVE_MCP_REFRESH_TOKEN`, `GOOGLE_DRIVE_MCP_CLIENT_ID`, `GOOGLE_DRIVE_MCP_CLIENT_SECRET` | read-only scopes at authorisation; `connectors.googleFolder` points the worker at the folder |
| GitHub | fine-grained PAT of the bot account | `GITHUB_TOKEN` | one repository |
| Claude Design | manual handoff in iteration 1 | — | — |

### Google Docs: `@piotr-agier/google-drive-mcp@2.13.0`

MIT, one maintainer, npm provenance and registry signatures, no install scripts. Its tools cover reading a Doc,
search and listing a folder. The `servers.json` fragment is in `agent/README.md`.

**Why way 1 and not a service account.** The server supports a service account only through
`GOOGLE_APPLICATION_CREDENTIALS`, a file path (it does `readFileSync`); it cannot take the key from a variable,
so the credential would not come from Infisical through the environment. A service account would need the deploy
to write a `0600` file; that is not what we wire. The server picks a mode in this order: service account,
external token, browser OAuth. **Never set `GOOGLE_APPLICATION_CREDENTIALS` on the server**, or it silently wins
over the refresh token.

**Variables** (external-token mode; the presence of the refresh token selects it): `GOOGLE_DRIVE_MCP_REFRESH_TOKEN`,
`GOOGLE_DRIVE_MCP_CLIENT_ID`, `GOOGLE_DRIVE_MCP_CLIENT_SECRET`.

**Scopes are fixed at consent time.** In external-token mode `GOOGLE_DRIVE_MCP_SCOPES` does nothing: the client is
built with the refresh token and no scopes. The server's default scopes are broad (full `drive`, `documents`,
`spreadsheets`, `presentations` and `calendar`, with write), so authorise on the laptop with the scopes set, or
Jarvis holds a token that can write to the owner's whole Drive and Calendar:

```sh
GOOGLE_DRIVE_MCP_SCOPES=https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/documents.readonly \
  npx -y @piotr-agier/google-drive-mcp@2.13.0 auth
```

The refresh token lands in `~/.config/google-drive-mcp/tokens.json`. Copy it by hand into Infisical `dev` and
`prod` (the project documents no export command), together with the client id and secret.

**The version is pinned deliberately.** This process holds a Google refresh token, and `npx -y` without a version
resolves the latest release on every run. Bump it by hand after reading the release.

**What `/api/connections` shows.** It reports `ok` when the three variables and `connectors.googleFolder` are set,
and names whichever are missing. That does not prove access: a bad or revoked token surfaces when a worker reads
the source and the task goes to `Blocked` (CTX-05).

**Verify at first setup** (the research could not confirm these):

- whether a service account can read a personal (non-Workspace) account's Doc after sharing;
- whether `drive.readonly` alone suffices for the Docs API, or `documents.readonly` is also required;
- whether publishing the consent screen to "In production" needs verification for these scopes;
- whether the server needs a writable home directory in external-token mode.
