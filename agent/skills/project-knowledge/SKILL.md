---
name: project-knowledge
description: How to work out, from a repository's own files, how to bring that project up for a UI check - the environment plan passed to start_dev_server, its services, ports and variables, the credential rule, and what to do when a start fails. Use before every start_dev_server call.
---

# Bringing an unknown project up

Jarvis is a generic engine: nothing about the repository you are working on is configured anywhere.
You read the repository, compose an **environment plan**, and pass it to
`mcp__jarvis__start_dev_server({plan})`. The engine runs the plan in disposable containers and gives
you a `baseUrl`. Your commands never run on the host, so a wrong plan costs one attempt, nothing else.

## 1. Read, in this order of trust

1. `AGENTS.md` / `CLAUDE.md` — a "run" or "dev" command written for agents is the best source.
2. `docker-compose*.yml`, `compose.yaml`, `Dockerfile` — which services exist, their images, ports and
   variable names. You do not run the compose file; you translate it into the plan.
3. `package.json` files (root and each app directory): `scripts`, `packageManager`, `engines`,
   workspaces. Lockfile decides the installer: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
   `package-lock.json` → `npm ci`, none → `npm install`.
4. `.env.example` / `.env.sample` — the **names** of the variables the app needs. Never the values of a
   real `.env`.
5. Framework config (`vite.config.*`, `next.config.*`, `angular.json`, …) and the server's entry
   file — the ports, and the variable the client reads the API URL from.
6. `README` — last: it is written for people and is often stale.

For another stack (Python, Ruby, Go, …) the same order applies with its own files
(`pyproject.toml`, `Gemfile`, `go.mod`, `Makefile`).

## 2. Compose the plan

```jsonc
{
  "image": "node:22-bookworm", // public image for the project's own commands
  "prepare": [
    // once, in the repo root, in order: installs, builds, migrations, seeds
    "npm --prefix server ci",
    "npm --prefix client ci",
  ],
  "services": [
    // with "image": its own container, reachable from the app BY ITS NAME (db:27017)
    { "name": "db", "image": "mongo:7", "ready": { "tcp": 27017 } },
    // without "image": a background process next to the app, reachable on 127.0.0.1
    { "name": "api", "command": "node server.js", "cwd": "server", "ready": { "tcp": 5001 } },
  ],
  "app": {
    // what the browser opens
    "command": "npm run dev -- --host 0.0.0.0 --port 5173",
    "cwd": "client",
    "port": 5173,
    "readyPath": "/",
  },
  "extraPorts": [5001], // other ports the BROWSER calls: the API
  "env": {
    "NODE_ENV": "development",
    "PORT": "5001",
    "DB_PASSWORD": { "generate": true },
    "MONGO_INITDB_ROOT_USERNAME": "app",
    "MONGO_INITDB_ROOT_PASSWORD": "${DB_PASSWORD}",
    "MONGODB_URI": "mongodb://app:${DB_PASSWORD}@db:27017/app?authSource=admin",
    "JWT_SECRET": { "generate": true },
    "VITE_API_URL": "http://127.0.0.1:5001",
  },
}
```

What is true about the place it runs:

- The sources are a **copy** at `/workspace` without `node_modules` and without `.git`. Everything
  must be installed in `prepare`. `cwd` is relative to the repository root.
- Image services start first, then `prepare`, then process services in order, then `app`. So a
  migration or a seed in `prepare` can already reach the database.
- Every variable in `env` reaches every container of the check.
- `app.port` and `extraPorts` are published on the **same numbers** on `127.0.0.1` of this machine —
  that is where the browser runs. So a URL the client calls (`VITE_API_URL`, `NEXT_PUBLIC_API_URL`, a
  CORS origin) is written with `http://127.0.0.1:<port>`, not with a service name.
- Whatever the browser reaches must **listen on `0.0.0.0`**, not on `localhost`: Vite needs
  `--host 0.0.0.0`, Next `-H 0.0.0.0`, Express/Fastify a `0.0.0.0` host. This is the most common reason
  for `not_ready`.
- The image is the runtime the repo asks for (`engines`, `.nvmrc`, `.python-version`). If the repo
  uses pnpm or yarn, start `prepare` with `corepack enable`.
- Prefer the dev command. Use build + preview only when the dev server cannot be made to listen on
  `0.0.0.0`.

Keep the plan as small as the UI scenarios need. A service the changed screens never touch is left out.

## 3. Credentials: never a literal

- A secret the app needs — a JWT secret, a database password, an API key it only signs with — is
  `{ "generate": true }`. The engine invents a value for this one check. You never see it.
- Another variable uses it as `${NAME}`: connection strings, the database image's own password
  variable.
- A password the **browser has to type** (a seeded admin account whose password comes from a
  variable) is `{ "generate": true, "reveal": true }`: the value comes back in `revealed` with the
  lease. Pass it to `ui-tester`, nowhere else.
- Never copy a value from a `.env`, a CI config or the owner's machine. Never write a real key of a
  third-party service; a feature that needs one is out of reach of the check — say so in the report.
- A plan with a literal credential is refused as `invalid_plan` with the variable named.

## 4. When the start fails

The refusal names the `step` and carries the end of its output in `detail`. Read it, change the one
thing it points at, call again:

| reason                        | usual cause                                                | change                                                   |
| ----------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `step_failed` at `prepare[n]` | wrong installer, missing system package, wrong directory   | fix that command or the image                            |
| `step_failed` at `services.x` | image name or command wrong; a required variable missing   | read the output                                          |
| `not_ready` at `app`          | listens on localhost, or on another port                   | `0.0.0.0`, the right `port`                              |
| `exited`                      | missing variable, database unreachable (name vs 127.0.0.1) | read the output                                          |
| `port_busy`                   | the port is taken on this machine                          | make the project use another port, everywhere it appears |
| `invalid_plan`                | a literal credential or an undefined `${NAME}`             | `{ "generate": true }`                                   |

You have `ui.maxStartAttempts` tries in one run. After the last, or on `docker_unavailable`,
`disabled`, `busy`, `untrusted_head`, `attempts_exhausted`: stop and report — the plans you tried, the
step that failed, its output, and what the owner could provide. Do not start anything with `Bash`
instead.
