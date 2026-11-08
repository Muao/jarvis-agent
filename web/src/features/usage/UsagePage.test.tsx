import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  JarvisConfigSchema,
  type ConfigDto,
  type UsageReport,
  type UsageRow,
} from '@jarvis/shared';
import { stubFetch } from '../../test/fakeFetch';
import { usage } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import { UsagePage } from './UsagePage';

const AT = '2026-10-26T10:00:00.000Z';
const tokens = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 };
const figures = {
  runs: 2,
  costUsd: 1.5,
  turns: 9,
  tokens,
  stopReasons: { completed: 1, running: 1 },
  durationMs: 65_000,
};

const config = (todayUsd: number): ConfigDto => ({
  valid: true,
  path: '/home/me/.jarvis/jarvis.config.json',
  loadedAt: AT,
  config: JarvisConfigSchema.parse({
    repo: { path: '/work/repo' },
    allowlist: { githubReviewers: ['alice'], autoAllowedCommands: ['pnpm test'] },
  }),
  usage: {
    ...usage({ todayUsd, budgetUsd: 20 }),
    byRole: { dispatcher: 0, worker: todayUsd },
    byTask: [],
  },
  repository: { checkCommands: [], devCommand: null, warning: null },
  profile: {
    soul: { path: 's', content: null, modifiedAt: null },
    user: { path: 'u', content: null, modifiedAt: null },
  },
});

const report = (groupBy: UsageReport['groupBy'], rows: UsageRow[], runs = 2): UsageReport => ({
  from: '2026-10-19T10:00:00.000Z',
  to: AT,
  groupBy,
  rows,
  total: { ...figures, runs },
});

const day = report('day', [{ key: '2026-10-25', ...figures }]);
const session = report('session', [
  { key: 'sess-1', ...figures, role: 'worker', threadId: 'th-1', taskId: 'T-1' },
]);

function stubUsage(overrides: Record<string, unknown> = {}) {
  const spy = stubFetch({ 'GET /api/config': config(12.4), 'GET /api/usage': day, ...overrides });
  return spy;
}

const lastUrl = (spy: ReturnType<typeof stubFetch>) => String(spy.mock.calls.at(-1)?.[0]);

describe('UsagePage', () => {
  it('renders rows, the total and stop reasons as text badges', async () => {
    stubUsage();
    renderWithProviders(<UsagePage />);
    const row = (await screen.findByRole('row', { name: /2026-10-25/ })).closest('tr')!;
    expect(within(row).getByText('completed ×1')).toBeInTheDocument();
    expect(within(row).getByText('running (not finished) ×1')).toBeInTheDocument();
    expect(within(row).getByText('$1.50')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Total' })).getByText('$1.50'),
    ).toBeInTheDocument();
  });

  it('shows the daily budget as text, and says the day buckets are UTC', async () => {
    stubUsage();
    renderWithProviders(<UsagePage />);
    expect(await screen.findByText('12.4 / 20 USD')).toBeInTheDocument();
    expect(screen.getByText(/local midnight/)).toHaveTextContent(/UTC dates/);
  });

  it('shows no NaN or undefined while loading', () => {
    stubUsage();
    renderWithProviders(<UsagePage />);
    expect(screen.getByText('Loading daily budget…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading usage…');
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it('refetches and re-renders when the grouping changes, with links to the session and task', async () => {
    const spy = stubUsage({ 'GET /api/usage': () => (lastCallIsSession(spy) ? session : day) });
    const user = userEvent.setup();
    renderWithProviders(<UsagePage />);
    await screen.findByText('2026-10-25');
    await user.click(screen.getByRole('button', { name: 'By session' }));
    const link = await screen.findByRole('link', { name: 'sess-1' });
    expect(link).toHaveAttribute('href', '/sessions/sess-1');
    expect(screen.getByRole('link', { name: 'T-1' })).toHaveAttribute('href', '/tasks/T-1');
    expect(lastUrl(spy)).toContain('groupBy=session');
  });

  it('explains the model grouping instead of showing zero turns', async () => {
    stubUsage({
      'GET /api/usage': report('model', [
        { key: 'claude-opus', ...figures, turns: 0, durationMs: 0 },
      ]),
    });
    const user = userEvent.setup();
    renderWithProviders(<UsagePage />);
    await user.click(await screen.findByRole('button', { name: 'By model' }));
    expect(await screen.findByText(/add up to less than the total/)).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /claude-opus/ });
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('notes that task-less runs are only in the total, and shows derived status', async () => {
    stubUsage({
      'GET /api/usage': report('task', [
        { key: 'T-1', ...figures, status: 'closed', stage: 'Done' },
      ]),
    });
    const user = userEvent.setup();
    renderWithProviders(<UsagePage />);
    await user.click(await screen.findByRole('button', { name: 'By task' }));
    expect(await screen.findByText(/no task .* appear only in the total/)).toBeInTheDocument();
    expect(screen.getByText('closed')).toBeInTheDocument();
  });

  it('says plainly that a fresh install has no runs', async () => {
    stubUsage({
      'GET /api/usage': {
        ...report('day', [], 0),
        total: { ...figures, runs: 0, costUsd: 0, turns: 0, stopReasons: {}, durationMs: 0 },
      },
    });
    renderWithProviders(<UsagePage />);
    expect(await screen.findByText('No runs in this window')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('sends a 30-day window without `to`, and never sends an invalid custom window', async () => {
    const spy = stubUsage();
    const user = userEvent.setup();
    renderWithProviders(<UsagePage />);
    await screen.findByText('2026-10-25');
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await screen.findByText('2026-10-25');
    expect(lastUrl(spy)).toMatch(/from=/);
    expect(lastUrl(spy)).not.toMatch(/to=/);

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick both');
    const calls = spy.mock.calls.length;
    await user.type(screen.getByLabelText(/^From/), '2025-01-01');
    await user.type(screen.getByLabelText(/^To/), '2026-10-01');
    expect(screen.getByRole('alert')).toHaveTextContent('wider than 366 days');
    expect(spy.mock.calls.filter(([url]) => String(url).includes('/api/usage')).length).toBe(
      calls - 1, // the config call is not a usage call
    );
  });

  it('sends an inclusive custom range as [from, next day)', async () => {
    const spy = stubUsage();
    const user = userEvent.setup();
    renderWithProviders(<UsagePage />);
    await user.click(await screen.findByRole('button', { name: 'Custom' }));
    await user.type(screen.getByLabelText(/^From/), '2026-10-01');
    await user.type(screen.getByLabelText(/^To/), '2026-10-03');
    await screen.findByText('2026-10-25');
    const url = decodeURIComponent(lastUrl(spy));
    expect(url).toContain('from=2026-10-01T00:00:00.000Z');
    expect(url).toContain('to=2026-10-04T00:00:00.000Z');
  });

  it('shows an error block when the report fails', async () => {
    stubUsage({
      'GET /api/usage': { status: 500, body: { code: 'internal', message: 'Boom' } },
    });
    renderWithProviders(<UsagePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load usage');
  });
});

function lastCallIsSession(spy: ReturnType<typeof stubFetch>) {
  return lastUrl(spy).includes('groupBy=session');
}
