import { InvalidInputError } from '../errors.js';

/** A pull request the owner pointed at, before the repo is resolved against the allow-list. */
export interface RequestedPullRequest {
  readonly number: number;
  /** `owner/name` when the reference names a repo; null for a bare number. */
  readonly repo: string | null;
  /** The canonical web URL, built from the reference. */
  readonly url: string | null;
}

const URL_REF = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const REPO_REF = /^([^/\s]+)\/([^/\s]+)#(\d+)$/;
const NUMBER_REF = /^#?(\d+)$/;

const HOW = 'use a PR URL, "owner/name#41", or a number together with `repo`';

/**
 * ADR-0018: what the dispatcher may pass as `pr`. A bare number carries no repo, so the caller has
 * to supply one — guessing a repo for a number would silently check a different pull request that
 * happens to share it.
 */
export function parsePullRequestRef(value: string): RequestedPullRequest {
  const text = value.trim();

  const url = URL_REF.exec(text);
  if (url) {
    const [, owner, name, number] = url;
    return {
      number: Number(number),
      repo: `${owner!}/${name!}`,
      url: `https://github.com/${owner!}/${name!}/pull/${number!}`,
    };
  }

  const repo = REPO_REF.exec(text);
  if (repo) {
    const [, owner, name, number] = repo;
    return {
      number: Number(number),
      repo: `${owner!}/${name!}`,
      url: `https://github.com/${owner!}/${name!}/pull/${number!}`,
    };
  }

  const bare = NUMBER_REF.exec(text);
  if (bare) {
    const number = Number(bare[1]);
    if (number === 0) throw new InvalidInputError(`"${value}" is not a pull request: ${HOW}`);
    return { number, repo: null, url: null };
  }

  throw new InvalidInputError(`Cannot read "${value}" as a pull request: ${HOW}`);
}

/** The web URL of a PR whose repo was only known after resolving it. */
export function pullRequestUrl(repo: { owner: string; name: string }, number: number): string {
  return `https://github.com/${repo.owner}/${repo.name}/pull/${number}`;
}
