import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const jarvisHome = resolve(process.env.JARVIS_HOME || join(homedir(), '.jarvis'));
const configPath = join(jarvisHome, 'jarvis.config.json');
const envPath = join(jarvisHome, '.env');
// Use the owner's GitHub CLI session, independently of Jarvis's bot credentials.
const ownerEnv = { ...process.env };
delete ownerEnv.GH_TOKEN;
delete ownerEnv.GITHUB_TOKEN;
ownerEnv.GH_HOST = 'github.com';
ownerEnv.GH_PROMPT_DISABLED = '1';

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', env: ownerEnv, ...options });
}

async function saveConfig(config, previousConfig) {
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  if (previousConfig === null) {
    await writeFile(configPath, contents, { flag: 'wx', mode: 0o600 });
    return;
  }

  const suffix = randomBytes(8).toString('hex');
  const backupPath = `${configPath}.${suffix}.bak`;
  const temporaryPath = `${configPath}.${suffix}.tmp`;
  await writeFile(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
  try {
    if ((await readFile(configPath, 'utf8')) !== previousConfig) {
      throw new Error(
        `Jarvis config changed during setup. Review ${configPath} before switching projects.`,
      );
    }
    await writeFile(backupPath, previousConfig, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  console.log(`Previous Jarvis config backed up to ${backupPath}.`);
}

async function createProject() {
  const previousConfig = await readFile(configPath, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const config = JSON.parse(
    previousConfig ??
      (await readFile(new URL('../jarvis.config.example.json', import.meta.url), 'utf8')),
  );

  run('git', ['--version']);
  run('gh', ['auth', 'status', '--hostname', 'github.com']);
  const owner = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
    env: ownerEnv,
    encoding: 'utf8',
  }).trim();

  const prompt = createInterface({ input: stdin, output: stdout });
  let name;
  let namespace;
  let projectPath;
  try {
    const selection = (
      await prompt.question(
        `GitHub owner: [1] ${owner}  [2] striped-wall-agency\nChoose 1 or 2, or enter another owner [1]: `,
      )
    ).trim();
    namespace =
      selection === '2'
        ? 'striped-wall-agency'
        : selection === '1' || !selection
          ? owner
          : selection;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(namespace)) {
      throw new Error('Enter a valid GitHub user or organization name.');
    }
    name = (await prompt.question('Project name: ')).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) {
      throw new Error(
        'Use 1–100 letters, digits, hyphens or underscores, starting with a letter or digit.',
      );
    }
    const defaultPath = join(homedir(), 'Projects', name);
    const destination = (await prompt.question(`Local folder [${defaultPath}]: `)).trim();
    projectPath = resolve(destination.replace(/^~\//, `${homedir()}/`) || defaultPath);
    if (existsSync(projectPath)) {
      throw new Error(`Choose a new folder. ${projectPath} already exists.`);
    }
    if (previousConfig !== null) {
      console.log(`Jarvis default project: ${config.repo.path} → ${projectPath}`);
    }
    const answer = await prompt.question(
      `Create private repository ${namespace}/${name} at ${projectPath}? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) return;
  } finally {
    prompt.close();
  }

  config.repo = { ...config.repo, path: projectPath, remote: 'origin', baseBranch: 'main' };
  if (previousConfig === null) config.allowlist.githubReviewers = [owner];

  run('git', ['var', 'GIT_AUTHOR_IDENT'], { stdio: ['ignore', 'ignore', 'inherit'] });
  run('git', ['var', 'GIT_COMMITTER_IDENT'], { stdio: ['ignore', 'ignore', 'inherit'] });
  await mkdir(dirname(projectPath), { recursive: true });
  await mkdir(projectPath);
  const git = (...args) => run('git', args, { cwd: projectPath });
  try {
    git('init', '-b', 'main');
    await writeFile(join(projectPath, 'README.md'), `# ${name}\n`, { flag: 'wx' });
    git('add', 'README.md');
    git('commit', '-m', 'chore: initialize repository');
    run('gh', [
      'repo',
      'create',
      `${namespace}/${name}`,
      '--private',
      '--source',
      projectPath,
      '--remote',
      'origin',
      '--push',
    ]);
    git('ls-remote', '--exit-code', 'origin', 'refs/heads/main');
    run('gh', ['repo', 'edit', `${namespace}/${name}`, '--default-branch', 'main']);
  } catch (error) {
    throw new Error(
      `Repository setup stopped. Check ${projectPath} and https://github.com/${namespace}/${name} before retrying. Any files or repository already created are still in place.`,
      { cause: error },
    );
  }

  await mkdir(jarvisHome, { recursive: true, mode: 0o700 });
  if (previousConfig === null) {
    const password = randomBytes(24).toString('hex');
    const env = [
      `POSTGRES_PASSWORD=${password}`,
      `DATABASE_URL=postgres://jarvis:${password}@127.0.0.1:5433/jarvis`,
      `DATABASE_URL_TEST=postgres://jarvis:${password}@127.0.0.1:5433/jarvis_test`,
      'GITHUB_TOKEN=',
      '',
    ].join('\n');
    try {
      await writeFile(envPath, env, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log(`Using existing environment file at ${envPath}.`);
    }
  }
  await saveConfig(config, previousConfig);
  console.log(`\nProject created at https://github.com/${namespace}/${name}`);
  if (previousConfig !== null) {
    console.log(
      'Restart pnpm dev to load the new default project. Check that the Jarvis bot has access to it before opening a PR.',
    );
    return;
  }
  console.log(
    `Jarvis config: ${configPath}\nContinue with GitHub bot access and startup in docs/running.md.`,
  );
}

createProject().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
