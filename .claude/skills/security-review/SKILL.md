---
name: security-review
description: Checks to run before any `git commit`, `git push`, or deploy (pnpm run deploy) in this repo — secrets, credentials, and other data that must never land in git or on the server. Use before staging/committing files, before opening a PR, before running scripts/deploy.sh, and whenever a new config, log statement, or fixture is added that might carry a real value instead of a placeholder.
---

# Security Review

Jarvis is a public repository (`docs/decisions/architecture/0016-...md`) and its secrets guard the owner's
Claude subscription login and every connected service (GitHub, Infisical, Notion, Google, Slack). A leaked
secret here is not a localhost mistake — it's a public GitHub repo. This skill is the checklist to run before
anything leaves the working tree: a commit, a push, or a deploy.

This is a local project skill, not a generic one: the rules below are this repo's own (ADR-0007, ADR-0016,
`.gitignore`), not a generic secret-scanner's defaults. Keep it that way — add project-specific checks here
rather than installing a third-party scanning skill that runs unreviewed shell commands over this code.

## Before `git commit` / `git push`

1. **Diff review, not just `git add`.** After any broad `git add`, run `git status` and `git diff --cached` and
   read every new/untracked file before committing — a suspicious filename ("config.local.json", "notes.txt")
   deserves a content check even if it looks innocuous.
2. **Grep staged changes for known secret shapes** (the same check ADR-0016's confirmation uses, run it on the
   diff, not the whole tree):
   ```sh
   git diff --cached | grep -nE "(ghp_|github_pat_|xox[bp]-|xapp-|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----|INFISICAL_CLIENT_SECRET=.+|ANTHROPIC_API_KEY=.+|ANTHROPIC_AUTH_TOKEN=.+)"
   ```
   Expect no output. These are: GitHub PATs, Slack bot/app tokens, AWS access key IDs, private key blocks, and
   any of this repo's own env vars assigned to something that isn't empty or a placeholder.
3. **Never commit a real value for a variable that `.env.example` or `jarvis.config.example.json` lists as a
   name only.** Those two files are the only place a variable name may appear with a placeholder; every other
   file either reads it from the environment or doesn't mention it.
4. **Check the files `.gitignore` already protects are still ignored**, especially after moving or renaming one:
   ```sh
   git check-ignore -v .env ~/.jarvis/.env jarvis.config.json
   ```
   If a file that should match comes back unignored, stop and fix `.gitignore` before committing anything.
5. **No `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` anywhere** — not in code, not in a committed `.env.example`
   value, not in a systemd unit, not in a doc's example command. ADR-0004: Jarvis only ever uses the `claude`
   CLI's own subscription login. Their presence in a diff is a correctness bug, not just a leak risk.
6. **Logs, fixtures, and test data use fake values.** A copy-pasted real token "for realism" in a test fixture
   or an example log line in a doc is still a leak. Use obviously-fake values (`ghp_xxx`, `sk-fake-...`) in
   anything committed.
7. **Diffs under `docs/`, `deploy/`, and `.claude/` get the same scrutiny as code.** Documentation is exactly
   where a real hostname, IP, token, or `ssh` one-liner copy-pasted from a terminal tends to sneak in.

## Before `pnpm run deploy` / any change to `scripts/deploy.sh`, `deploy/systemd/*`, or `compose.yaml`

1. **No secret value is ever passed as a CLI argument.** Arguments are visible in `ps`; secrets must travel
   through the environment only (this is why `scripts/with-secrets.sh` uses `export`, not `"$1"` substitution —
   keep new code consistent with that).
2. **`/etc/jarvis/infisical.env` stays `root:root`, mode `0600`.** Verify, don't assume, after any change that
   touches it or the systemd units that read it:
   ```sh
   stat -c '%a %U:%G' /etc/jarvis/infisical.env   # expect: 600 root:root
   ```
3. **No new secret file lands in `~jarvis`'s home readable by the `jarvis` user if it doesn't need to be.** The
   residual risk in `deploy/README.md` (`claude` running as the same uid as the engine can read its environ) is
   accepted for the single-owner box as-is; don't make it worse by adding a second same-uid secret store.
4. **A new service gets a health check before it gets a restart.** Don't wire a new systemd unit into the deploy
   flow without an `ExecStartPost` (or equivalent) the way `jarvis-engine.service` has — see the `deployment`
   skill for why.
5. **A new public-facing surface is a decision, not a side effect.** Enabling `jarvis-web`, running
   `tailscale serve`, or opening any port beyond `127.0.0.1` must be a deliberate, separately-confirmed step —
   never bundled into an unrelated deploy-script change. (This is exactly the state Jarvis is in right now:
   `jarvis-web` is installed but intentionally not enabled.)
6. **Firewall stays tailnet-only unless someone explicitly decides otherwise.** `ss -tlnp` on the server should
   show engine/web/Postgres on `127.0.0.1` only (ADR-0015's confirmation check); re-run it after any change to
   `JARVIS_LISTEN_HOST`, `compose.yaml` port mappings, or the Hetzner Cloud Firewall rules.

## If something was already committed

A secret that reached a commit is compromised the moment it's pushed, even if a later commit removes it — git
history keeps it. Rotate the credential first (new token, new password, revoke the old one), *then* clean the
history (`git filter-repo` or BFG) if the repo is shared, and tell the owner either way. Removing the line in a
new commit without rotating the credential fixes nothing.

## Popular tools worth running, if installed

These are optional, not required — the greps above cover this repo's own secret shapes without any extra
install:

- [`gitleaks`](https://github.com/gitleaks/gitleaks) `gitleaks protect --staged` — broad pattern+entropy scan of
  a diff before commit.
- [`trufflehog`](https://github.com/trufflesecurity/trufflehog) `trufflehog git file://. --since-commit HEAD~1
  --only-verified` — verifies found secrets are live rather than just pattern-shaped, fewer false positives.
- [`git-secrets`](https://github.com/awslabs/git-secrets) as a pre-commit hook — same idea as the grep above,
  wired into `git commit` automatically instead of run by hand.

None of these are installed in this repo; if adding one, wire it as a local git hook or a `pnpm` script, not a
CI step that needs network access to secrets to validate itself.
