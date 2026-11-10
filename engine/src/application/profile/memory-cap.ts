import { parseMemory, selectForWorker, type Task } from '../../domain/index.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { RepoResolver } from '../ports/repo-resolver.js';
import { taskRepoSlug } from './memory-support.js';

export interface MemoryCapDeps {
  readonly profile: ProfileStore;
  readonly repos: RepoResolver;
  readonly config: ConfigProvider;
}

/** ADR-0021: would a worker run on this task's repository now have part of the memory cut away? */
export class MemoryCap {
  constructor(private readonly deps: MemoryCapDeps) {}

  async overCap(task: Pick<Task, 'targetRepo'>): Promise<boolean> {
    const { softCapChars } = this.deps.config.current().memory;
    const repo = taskRepoSlug(task, this.deps.repos) ?? '';
    const document = parseMemory(await this.deps.profile.read());
    return selectForWorker(document, repo, softCapChars).cut;
  }
}
