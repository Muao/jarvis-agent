import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JarvisConfigSchema, type ConfigDto } from '@jarvis/shared';
import { stubFetch } from '../../test/fakeFetch';
import { usage } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ConfigPage } from './ConfigPage';

const AT = '2026-10-26T10:00:00.000Z';

const valid = (patch: { warning?: string | null } = {}): ConfigDto => ({
  valid: true,
  path: '/home/me/.jarvis/jarvis.config.json',
  loadedAt: AT,
  config: JarvisConfigSchema.parse({
    repo: { path: '/work/repo' },
    allowlist: { githubReviewers: ['alice'], autoAllowedCommands: ['pnpm test'] },
  }),
  usage: {
    ...usage({ todayUsd: 17 }),
    byRole: { dispatcher: 2, worker: 15 },
    byTask: [{ taskId: 'T-1', costUsd: 15 }],
  },
  repository: {
    checkCommands: ['pnpm test'],
    devCommand: 'pnpm dev',
    warning: patch.warning ?? null,
  },
  profile: {
    soul: { path: '/home/me/.jarvis/SOUL.md', content: '# Soul\n\nBe brief.', modifiedAt: AT },
    user: { path: '/home/me/.jarvis/USER.md', content: null, modifiedAt: null },
  },
});

describe('ConfigPage', () => {
  it('renders usage, limits, repository, profile and allowlists read-only', async () => {
    stubFetch({ 'GET /api/config': valid({ warning: 'AGENTS.md has no dev command' }) });
    renderWithProviders(<ConfigPage />);

    expect(await screen.findByText(/notional \$17\.00 \/ \$20\.00 today/)).toBeInTheDocument();
    expect(screen.getByText(/Near limit \(85%\)/)).toBeInTheDocument();
    expect(screen.getByText('worker: notional $15.00')).toBeInTheDocument();
    expect(screen.getByText('T-1: notional $15.00')).toBeInTheDocument();

    const limits = screen.getByRole('region', { name: 'Limits' });
    const row = within(limits).getByRole('row', { name: /maxConcurrentWorkers/ });
    expect(within(row).getByRole('cell', { name: '1' })).toBeInTheDocument();
    expect(within(limits).getByText('/home/me/.jarvis/jarvis.config.json')).toBeInTheDocument();

    const repo = screen.getByRole('region', { name: 'Repository' });
    expect(within(repo).getByText('/work/repo')).toBeInTheDocument();
    expect(within(repo).getByText('pnpm dev')).toBeInTheDocument();
    expect(within(repo).getByRole('alert')).toHaveTextContent('AGENTS.md has no dev command');

    expect(screen.getByRole('heading', { name: 'Soul' })).toBeInTheDocument();
    expect(screen.getByText('File not found.')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows config errors and the tasks-do-not-start note when invalid', async () => {
    stubFetch({
      'GET /api/config': {
        valid: false,
        path: '/home/me/.jarvis/jarvis.config.json',
        errors: ['limits.dailyBudgetUsd: Too small', 'repo.path: Required'],
      },
    });
    renderWithProviders(<ConfigPage />);

    const errors = await screen.findByRole('list', { name: 'Config errors' });
    expect(within(errors).getByText('limits.dailyBudgetUsd: Too small')).toBeInTheDocument();
    expect(within(errors).getByText('repo.path: Required')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Tasks do not start');
    expect(screen.queryByRole('region', { name: 'Limits' })).not.toBeInTheDocument();
  });
});
