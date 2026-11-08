---
status: superseded
date: 2026-11-02
decision-makers: []  # owner chose a secret manager (Infisical / Doppler) 2026-11-02; Claude picked Infisical; awaiting Ivan Lapa
scope: [".env.example", "engine/package.json", "docs/architecture/deployment.md"]
supersedes: []
superseded-by: ["0024"]
---

# ADR-0016: Keep secrets in Infisical and inject them with `infisical run`; `~/.jarvis/.env` stays as the local fallback

## Context and Problem Statement
ADR-0007 keeps secrets in a plaintext `~/.jarvis/.env` and plans a secret manager "later". With Jarvis
moving to a server (ADR-0015) the same secrets are needed on the laptop and on the VPS, and the repo is
public, so encrypted secret files in git are ruled out. The Claude subscription is not a secret Jarvis
holds: it is the `claude` login on each machine.

## Considered Options
- Infisical Cloud (open source, free tier, can be self-hosted later): `infisical run --env=<env> -- <cmd>`
- Doppler (hosted only, free developer plan): `doppler run -- <cmd>`
- GitHub Environment secrets written to `.env` by a deploy workflow
- 1Password CLI with a service account

## Decision Outcome
Chosen option: "Infisical", because its `run` wrapper injects the same variable names ADR-0007 defines
(no code change), the laptop and the server read one source, and being open source it can move onto the
VPS if the hosted service stops fitting.

- **Project** `jarvis` with environments `dev` (laptop) and `prod` (VPS). Variables exactly as in `.env.example`.
- **Laptop.** `infisical login` (owner's account), `infisical run --env=dev -- pnpm dev`.
- **Server.** A machine identity with Universal Auth, read-only on `prod`. Its client id and secret are the only secrets on disk: `/etc/jarvis/infisical.env`, `root:root`, mode `0600` (systemd reads `EnvironmentFile=` as root, and the engine's user also runs `claude`, so a group-readable file would let a run read the client secret), loaded by the systemd units, which run `infisical run --env=prod -- pnpm …`.
- **Fallback.** Without Infisical the engine still reads `~/.jarvis/.env` (`--env-file-if-exists`); webinar participants keep the ADR-0007 path.
- **Rotation.** Change the value in Infisical, `systemctl restart jarvis-engine`.

### Consequences
- Good, because no plaintext secrets on the server except the read-only machine identity.
- Good, because ADR-0007's guarantees hold: secrets are read in `infrastructure/config`, redacted in logs, allow-listed into child envs.
- Bad, because one more account and CLI; if Infisical is down at start-up the engine does not start (running processes are unaffected).
- Bad, because a child `claude` runs as the same uid as the engine and can read `/proc/<engine-pid>/environ`, so the injected secrets are not hidden from it; the child-env allow-list limits inheritance only. Accepted for a single-owner server; a separate uid for child processes is the real fix.

### Confirmation
- RULE: No secret values in the repo; `.env.example` lists names only.
  CHECK: `git grep -nE "(ghp_|github_pat_|xox[bp]-|secret_)"` (expect none)
- RULE: On the server the only secret file is `/etc/jarvis/infisical.env`, `root:root`, mode `0600`; there is no `~/.jarvis/.env`.
  CHECK: `test "$(stat -c '%a %U:%G' /etc/jarvis/infisical.env)" = '600 root:root' && test ! -e ~jarvis/.jarvis/.env`
