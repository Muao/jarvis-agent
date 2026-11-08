#!/usr/bin/env bash
# PreToolUse(Bash) gate: before a git commit/push or a deploy, run the secret-pattern check
# from .claude/skills/security-review/SKILL.md ourselves, instead of counting on the model to
# remember to invoke that skill. Blocks the real command if a known secret shape is found.
set -euo pipefail

input="$(cat)"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

[ -n "$command" ] || exit 0

# Only act on commands that actually commit, push, or deploy. Anything else passes through
# untouched (exit 0, no output = allow, no noise).
if ! printf '%s' "$command" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+commit([[:space:]]|$)|(^|[;&|[:space:]])git[[:space:]]+push([[:space:]]|$)|pnpm[[:space:]]+run[[:space:]]+deploy|scripts/deploy\.sh'; then
  exit 0
fi

cd "$(dirname "$0")/../.." || exit 0

SECRET_PATTERN='(ghp_|github_pat_|xox[bp]-|xapp-|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----|INFISICAL_CLIENT_SECRET=.+|ANTHROPIC_API_KEY=.+|ANTHROPIC_AUTH_TOKEN=.+)'

# Files that define or document these patterns legitimately contain them (the regex itself,
# and fake examples like `ghp_xxx`) — exclude them from the scan, or every change to this
# gate or the security-review skill would false-positive on its own documentation.
EXCLUDE_PATHSPEC=(
  ':(exclude).claude/hooks/security-review-gate.sh'
  ':(exclude).claude/skills/security-review/SKILL.md'
)

# What to scan depends on the action: staged diff for a commit, not-yet-pushed commits for a
# push, and the working tree for a deploy (nothing is committed from the deploy path, but
# scripts/deploy.sh itself and any local edits to it are worth a last look).
findings=""
if printf '%s' "$command" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+commit([[:space:]]|$)'; then
  findings="$(git diff --cached -- . "${EXCLUDE_PATHSPEC[@]}" 2>/dev/null | grep -nE "$SECRET_PATTERN" || true)"
  scope="staged changes (git diff --cached)"
elif printf '%s' "$command" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
  range_diff="$(git diff '@{u}..HEAD' -- . "${EXCLUDE_PATHSPEC[@]}" 2>/dev/null || git diff 'origin/main..HEAD' -- . "${EXCLUDE_PATHSPEC[@]}" 2>/dev/null || true)"
  findings="$(printf '%s' "$range_diff" | grep -nE "$SECRET_PATTERN" || true)"
  scope="commits about to be pushed"
else
  findings="$(git diff -- . "${EXCLUDE_PATHSPEC[@]}" 2>/dev/null | grep -nE "$SECRET_PATTERN" || true)"
  scope="working tree (uncommitted changes)"
fi

if [ -n "$findings" ]; then
  reason="security-review: possible secret pattern found in $scope. Review .claude/skills/security-review/SKILL.md before proceeding. Matches:
$findings"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    },
    systemMessage: $reason
  }'
  exit 0
fi

jq -n --arg scope "$scope" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: ("security-review: no known secret pattern found in " + $scope + ".")
  }
}'
