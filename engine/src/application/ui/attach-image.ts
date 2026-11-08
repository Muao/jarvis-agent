import type { ArtifactBlob, ArtifactStore } from '../ports/artifact-store.js';
import type { CodeHost } from '../ports/code-host.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';

export interface AttachImageInput {
  /** Relative to the task's artifacts directory. */
  readonly path: string;
  readonly alt: string;
}

export type AttachImageResult =
  | { readonly ok: true; readonly url: string; readonly markdown: string }
  | { readonly ok: false; readonly reason: string };

export const ATTACHED = 'ui_screenshot_attached';

export interface AttachImageDeps extends TaskDeps {
  readonly config: ConfigProvider;
  readonly artifacts: ArtifactStore;
  readonly codeHost: CodeHost;
}

/**
 * ADR-0014: the worker's `attach_image`. Uploads one screenshot and returns the markdown to paste
 * into the PR body. Every refusal — disabled, too many, too big, GitHub saying no — comes back as
 * `{ ok: false, reason }`, because the alternative is a PR full of broken images.
 */
export class AttachImage {
  constructor(private readonly deps: AttachImageDeps) {}

  async execute(identity: RunIdentity, input: AttachImageInput): Promise<AttachImageResult> {
    const ui = this.deps.config.current().ui;

    const { task, attached } = await transact(this.deps, async (tx) => {
      const found = await loadWorkerTask(tx, identity);
      const journal = await tx.journal.list(found.id);
      return { task: found, attached: journal.filter((e) => e.type === ATTACHED).length };
    });

    if (!ui.attachToPr) {
      return {
        ok: false,
        reason:
          'attachments_disabled: ui.attachToPr is false. List the screenshot file names in the PR body instead.',
      };
    }
    if (attached >= ui.maxScreenshots) {
      return {
        ok: false,
        reason: `screenshot_limit_reached: ${ui.maxScreenshots} screenshots are already attached to this task.`,
      };
    }

    let blob: ArtifactBlob;
    try {
      blob = await this.deps.artifacts.readImage(task.id, input.path);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    const limitBytes = ui.maxImageMb * 1024 * 1024;
    if (blob.sizeBytes === 0) {
      return { ok: false, reason: `${input.path} is empty; nothing to attach.` };
    }
    if (blob.sizeBytes > limitBytes) {
      return {
        ok: false,
        reason: `${input.path} is ${(blob.sizeBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${ui.maxImageMb} MB.`,
      };
    }

    const uploaded = await this.deps.codeHost.uploadAttachment({
      name: blob.name,
      contentType: blob.contentType,
      bytes: blob.bytes,
      ...(task.targetRepo === null ? {} : { repo: task.targetRepo }),
    });

    await transact(this.deps, async (tx) => {
      await this.deps.writer.note(
        tx,
        task.id,
        uploaded.ok ? ATTACHED : 'ui_screenshot_attach_failed',
        'system',
        uploaded.ok
          ? { path: input.path, url: uploaded.url }
          : { path: input.path, reason: uploaded.reason },
      );
    });

    if (!uploaded.ok) return { ok: false, reason: uploaded.reason };
    return {
      ok: true,
      url: uploaded.url,
      markdown: `![${input.alt}](${uploaded.url})`,
    };
  }
}
