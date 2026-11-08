import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Layout of `~/.jarvis` (ADR-0009). Pure path arithmetic; `ensureHome` is the only side effect. */
export interface JarvisHome {
  readonly root: string;
  readonly userFile: string;
  readonly configFile: string;
  readonly envFile: string;
  readonly mcpServersFile: string;
  readonly dispatcherDir: string;
  worktreeDir(taskId: string): string;
  taskDir(taskId: string): string;
  runDir(runId: string): string;
}

/** Ids become path segments: reject anything that could escape the home. */
function segment(id: string): string {
  if (id === '' || id === '.' || id === '..' || /[\\/\0]/.test(id)) {
    throw new Error(`Invalid path segment: ${JSON.stringify(id)}`);
  }
  return id;
}

export function jarvisHome(root: string): JarvisHome {
  return {
    root,
    userFile: join(root, 'USER.md'),
    configFile: join(root, 'jarvis.config.json'),
    envFile: join(root, '.env'),
    mcpServersFile: join(root, 'mcp', 'servers.json'),
    dispatcherDir: join(root, 'dispatcher'),
    worktreeDir: (taskId) => join(root, 'worktrees', segment(taskId)),
    taskDir: (taskId) => join(root, 'tasks', segment(taskId)),
    runDir: (runId) => join(root, 'runs', segment(runId)),
  };
}

/** Creates the home and its fixed subdirectories (idempotent). */
export async function ensureHome(home: JarvisHome): Promise<void> {
  const dirs = [
    home.root,
    join(home.root, 'mcp'),
    home.dispatcherDir,
    join(home.root, 'worktrees'),
    join(home.root, 'tasks'),
    join(home.root, 'runs'),
  ];
  for (const dir of dirs) await mkdir(dir, { recursive: true });
}
