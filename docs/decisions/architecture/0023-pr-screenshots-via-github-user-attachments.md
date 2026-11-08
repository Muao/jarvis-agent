---
status: accepted
date: 2026-11-08
decision-makers: [] # owner: screenshots inline in the PR body, not in a Jarvis gallery (2026-11-08); drafted by Claude
scope:
  [
    'engine/src/application/ports/code-host.ts',
    'engine/src/application/ports/artifact-store.ts',
    'engine/src/application/ui/attach-image.ts',
    'engine/src/infrastructure/github/**',
    'engine/src/infrastructure/artifacts/**',
    'shared/src/mcp.ts',
  ]
supersedes: []
superseded-by: []
---

# ADR-0023: Put the UI check's screenshots inline in the PR body through GitHub's undocumented `user-attachments` upload

## Context and Problem Statement

The UI check (ADR-0022) produces screenshots that are only worth taking if the owner sees them where
they already review: in the pull request. GitHub has no documented API for comment attachments — the
request has been open in community discussions for years, and officially an image gets into an issue
or PR body by being dropped into the browser. The installed `gh` (2.97.0) has no `--attach`.

That leaves three ways to show an image in a PR body, and for a private repository two of them do
not work: GitHub's camo proxy cannot read private content, so an image committed to the branch or
pushed to a side branch and linked by raw URL renders as a broken image, not as a picture.

## Considered Options

- **Commit the screenshots into the task branch.** Supported, no undocumented calls. Puts binaries
  in the diff and in the target repository's history, and does not render inline in a private repo.
- **A side branch plus raw URLs.** Keeps the diff clean; same private-repo rendering problem, and
  the reader has to click.
- **`POST https://uploads.github.com/user-attachments/assets`** — the endpoint GitHub's own web UI
  posts to, authenticated with a bearer token.
- **A gallery in Jarvis's own web UI**, with the PR carrying a link. Fully supported, nothing
  undocumented, but the evidence then lives away from where review happens.

## Decision Outcome

Chosen option: **the undocumented `user-attachments` upload**. Confirmed by the owner (2026-11-08),
who chose the PR body over a Jarvis-side gallery. It is the only option that renders inline in a
private repository, and inline is the point: a link the reviewer has to open is not evidence they
will look at.

- One request: `POST https://uploads.github.com/user-attachments/assets?name=&content_type=&repository_id=`
  with `Authorization: Bearer <token>`, `Accept: application/json` and the raw bytes as the body.
  `repository_id` comes from `GET /repos/{owner}/{repo}` and is cached per process. The response
  carries the `github.com/user-attachments/assets/...` URL that goes into the PR body as markdown.
- **It lives behind `CodeHost.uploadAttachment`,** one adapter with its own tests against a fake
  `fetch`. When GitHub changes or withdraws the endpoint, one file changes.
- **Failure is a value, not an exception.** `attach_image` answers `{ ok: false, reason }` on 401,
  403, 404, 410 and 5xx, and the worker's prompt requires it to then write the file name as plain
  text in the PR. A PR full of broken images is worse than a PR with a line saying the upload failed.
- **The agent never handles the token or builds the request.** It calls `attach_image` with a path
  relative to its own artifacts directory; the engine resolves the path, refuses anything that
  leaves the directory (`..`, an absolute path, or a symlink pointing out, checked after resolving
  symlinks), refuses anything that is not an image, refuses an empty file or one over
  `ui.maxImageMb`, and stops at `ui.maxScreenshots` per task.
- **`ui.attachToPr: false`** turns the upload off without turning the UI check off, which is the
  escape hatch if the endpoint starts refusing our token.
- The uploaded asset is tied to a repository, not to a PR, so the URLs survive a PR being closed and
  reopened.

### Consequences

- Good: the reviewer sees the UI the agent saw, in the place they already read.
- Good: the whole undocumented surface is one method with one fallback, and the fallback is exercised
  by tests rather than discovered in production.
- Bad: an undocumented endpoint can change or start refusing tokens without notice. The one source
  describing it notes that it previously accepted only a browser session cookie and that token auth
  is recent.
- Bad: **unverified for our credentials.** Whether this endpoint accepts a fine-grained PAT is not
  known — the write-ups use `gh auth token`, an OAuth user token, while the plan for Jarvis is a
  fine-grained PAT scoped to one repository. This has to be tried on a real PR before the feature is
  trusted; if it refuses, the choice is a classic PAT or `ui.attachToPr: false`.

## More Information

- `docs/specs/ui-verification.md`, sections 5.7 and 10.1 — the contract and the open question.
- [Programmatically upload attachments to GitHub Issues, Pull Requests, and Comments](https://island94.org/2026/08/programmatically-upload-attachments-to-github-issues-pull-requests-comments)
- [Comment API for uploading images/attachments · community discussion #28219](https://github.com/orgs/community/discussions/28219)
