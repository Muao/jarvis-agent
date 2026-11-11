import type { JarvisConfig } from '@jarvis/shared';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ThreadMessages } from '../conversation/thread-messages.js';
import { InvalidInputError } from '../errors.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { RunIdentity } from '../run-identity.js';
import { requireDispatcher } from '../tasks/guards.js';
import { transact, type TransactionDeps } from '../transaction.js';

export interface UpdateConfigInput {
  readonly patch: Record<string, unknown>;
}

/**
 * ADR-0013: fields other ADRs already locked down, or that would change the identity of the
 * running engine. Listed as full dotted paths, never silently stripped: a patch touching any of
 * these rejects the whole call.
 */
export const FORBIDDEN_PATHS = [
  'repo.path',
  'repo.remote',
  'repo.baseBranch',
  'repos.allow',
  'repos.allowOwnerRepos',
  'repos.allowSelf',
  'engine.port',
  'engine.claudeBinary',
  // What a check runs in, whether its browser is sandboxed and which diffs count as UI are the
  // owner's; `ui.autoApproveComments` disables the only gate before writing to a pull request.
  'ui.defaultImage',
  'ui.noSandbox',
  'ui.paths',
  'ui.autoApproveComments',
  // ADR-0018: this list decides whose pull request may run its code here without asking the owner.
  // A trust boundary is not a setting to be talked into.
  'allowlist.githubReviewers',
] as const;

function forbiddenPathIn(patch: Record<string, unknown>): string | null {
  for (const path of FORBIDDEN_PATHS) {
    let node: unknown = patch;
    let matched = true;
    for (const segment of path.split('.')) {
      if (typeof node !== 'object' || node === null || !(segment in node)) {
        matched = false;
        break;
      }
      node = (node as Record<string, unknown>)[segment];
    }
    if (matched) return path;
  }
  return null;
}

export interface UpdateConfigDeps extends TransactionDeps {
  readonly messages: ThreadMessages;
  readonly config: ConfigProvider;
}

/**
 * ADR-0013: dispatcher-only. Merges `patch` into `jarvis.config.json` and validates the whole
 * result against `JarvisConfigSchema`, same validation path as a manual edit (ADR-0005); writes
 * only if it parses. Never touches any path in `FORBIDDEN_PATHS` above, regardless of what the
 * patch asks: a patch naming any of them (even alongside otherwise-valid fields) rejects the
 * whole call, with a message the dispatcher can relay to the owner verbatim. A successful call is
 * posted into the thread so the change is visible in history, not just in the file.
 */
export class UpdateConfig {
  constructor(private readonly deps: UpdateConfigDeps) {}

  async execute(identity: RunIdentity, input: UpdateConfigInput): Promise<JarvisConfig> {
    requireDispatcher(identity);

    const offending = forbiddenPathIn(input.patch);
    if (offending !== null) {
      throw new InvalidInputError(
        `"${offending}" is not editable from chat; edit jarvis.config.json yourself.`,
      );
    }

    let config: JarvisConfig;
    try {
      config = await this.deps.config.update(input.patch);
    } catch (error) {
      throw new InvalidInputError(error instanceof Error ? error.message : String(error));
    }

    await transact(this.deps, async (tx, outbox) => {
      const body: BodyOf<'jarvis'> = {
        text: `Updated jarvis.config.json: ${JSON.stringify(input.patch)}`,
      };
      await this.deps.messages.post(tx, outbox, {
        threadId: identity.threadId,
        taskId: null,
        kind: 'jarvis',
        body,
      });
    });

    return config;
  }
}
