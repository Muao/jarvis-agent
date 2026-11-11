import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewDto } from '@jarvis/shared';
import { stubFetch } from '../../test/fakeFetch';
import { overview, usage } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import { OverviewPage } from './OverviewPage';

const busy = (patch: Record<string, unknown> = {}) => ({
  state: 'busy' as const,
  taskId: 'T-12',
  title: 'Add login page',
  stage: 'Implementing' as const,
  action: 'Edit src/login.tsx',
  startedAt: new Date(Date.now() - 125_000).toISOString(),
  sessionId: 'sess-1',
  runCostUsd: 0.42,
  ...patch,
});

const render = (data: OverviewDto) => {
  stubFetch({ 'GET /api/overview': data });
  return renderWithProviders(<OverviewPage />);
};

afterEach(() => vi.useRealTimers());

describe('OverviewPage', () => {
  it('shows KPIs, busy and free worker slots, queue and stalled marker', async () => {
    render(
      overview({
        workers: [
          busy(),
          busy({ state: 'stalled', taskId: 'T-13', sessionId: 's2' }),
          { state: 'free' },
        ],
        queue: [{ taskId: 'T-14', what: 'new_task', since: new Date().toISOString(), position: 1 }],
        waitingForOwner: 2,
        prsOpen: 1,
      }),
    );
    const kpis = await screen.findByRole('list', { name: 'Key figures' });
    expect(within(kpis).getByText('2/3')).toBeInTheDocument();
    expect(within(kpis).getByText('3.2M / 20M tokens')).toBeInTheDocument();

    const worker1 = screen.getByRole('article', { name: 'Worker 1' });
    expect(within(worker1).getByText('Add login page', { exact: false })).toBeInTheDocument();
    expect(within(worker1).getByText('Edit src/login.tsx')).toBeInTheDocument();
    expect(within(worker1).getByText(/notional \$0\.42/)).toBeInTheDocument();
    expect(within(worker1).getByRole('link', { name: 'Console →' })).toHaveAttribute(
      'href',
      '/sessions/sess-1',
    );
    expect(within(worker1).getByRole('list', { name: 'Task progress' })).toBeInTheDocument();

    expect(
      within(screen.getByRole('article', { name: 'Worker 2' })).getByText(/Stalled/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: 'Worker 3' })).getByText('Free'),
    ).toBeInTheDocument();

    const queue = screen.getByRole('region', { name: 'Queue' });
    expect(within(queue).getByText('New task')).toBeInTheDocument();
    expect(screen.queryByText('Jarvis is idle')).not.toBeInTheDocument();
  });

  it('counts down the next check of a watched PR', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      overview({
        watching: [
          {
            taskId: 'T-12',
            stage: 'PR Open',
            prUrl: 'https://github.com/o/r/pull/5',
            ci: 'running',
            review: 'pending',
            lastCheckedAt: new Date().toISOString(),
            nextCheckAt: new Date(Date.now() + 30_000).toISOString(),
          },
        ],
      }),
    );
    expect(await screen.findByText(/next check in (29|30) s/)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.getByText(/next check in (19|20) s/)).toBeInTheDocument();
  });

  it('filters the event log and pauses it', async () => {
    const user = userEvent.setup();
    const events = [
      {
        id: 'e1',
        at: '2026-10-26T10:00:00.000Z',
        taskId: 'T-1',
        type: 'stage' as const,
        text: 'Moved to Spec',
      },
      {
        id: 'e2',
        at: '2026-10-26T10:01:00.000Z',
        taskId: 'T-2',
        type: 'ci' as const,
        text: 'CI failed',
      },
    ];
    stubFetch({ 'GET /api/overview': overview({ events }) });
    const { queryClient } = renderWithProviders(<OverviewPage />);
    const log = await screen.findByRole('region', { name: 'Event log' });

    const items = within(log).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('CI failed'); // newest first

    await user.selectOptions(within(log).getByLabelText('Type'), 'stage');
    expect(within(log).queryByText('CI failed')).not.toBeInTheDocument();
    expect(within(log).getByText('Moved to Spec')).toBeInTheDocument();
    await user.selectOptions(within(log).getByLabelText('Type'), '');
    await user.selectOptions(within(log).getByLabelText('Task'), 'T-2');
    expect(within(log).queryByText('Moved to Spec')).not.toBeInTheDocument();
    await user.selectOptions(within(log).getByLabelText('Task'), '');

    await user.click(within(log).getByRole('button', { name: 'Pause' }));
    queryClient.setQueryData(
      ['overview'],
      overview({
        events: [
          ...events,
          { id: 'e3', at: '2026-10-26T10:02:00.000Z', taskId: 'T-2', type: 'error', text: 'Boom' },
        ],
      }),
    );
    expect(await within(log).findByText(/Log paused — 1 new/)).toBeInTheDocument();
    expect(within(log).queryByText('Boom')).not.toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Resume' }));
    expect(within(log).getByText('Boom')).toBeInTheDocument();
  });

  it('shows the idle state', async () => {
    render(overview());
    expect(await screen.findByText('Jarvis is idle')).toBeInTheDocument();
  });

  it('shows Paused on slots when the budget is reached', async () => {
    render(
      overview({
        usage: usage({ todayTokens: 20_000_000, paused: true }),
        workers: [{ state: 'free' }],
      }),
    );
    const worker = await screen.findByRole('article', { name: 'Worker 1' });
    expect(within(worker).getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('Jarvis is idle')).not.toBeInTheDocument();
  });

  it('shows engine offline when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderWithProviders(<OverviewPage />);
    expect(await screen.findByText('Engine offline')).toBeInTheDocument();
  });
});
