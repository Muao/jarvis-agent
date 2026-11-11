import { Route, Routes } from 'react-router';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { stubFetch, type FakeRoutes } from '../../test/fakeFetch';
import { FakeEventSource } from '../../test/FakeEventSource';
import { overview, usage } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import { run, taskDetail } from './fixtures';
import { TaskDetailPage } from './TaskDetailPage';

const specArtifact = (content: string | null) => ({
  name: 'spec.md',
  exists: content !== null,
  content,
  updatedAt: '2026-10-26T10:00:00.000Z',
});

function renderDetail(routes: FakeRoutes, taskId = 'T-12', search = '') {
  const spy = stubFetch({ 'GET /api/overview': overview(), ...routes });
  const view = renderWithProviders(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
    </Routes>,
    { route: `/tasks/${taskId}${search}` },
  );
  FakeEventSource.current.open();
  return { spy, ...view };
}

const posts = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url));

describe('TaskDetailPage', () => {
  it('renders every block from the task', async () => {
    renderDetail({
      'GET /api/tasks/T-12': taskDetail(),
      'GET /api/tasks/T-12/artifacts/context.md': {
        ...specArtifact('# Context'),
        name: 'context.md',
      },
    });

    // header
    expect(
      await screen.findByRole('heading', { name: 'Add the export page', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('T-12')).toBeInTheDocument();
    expect(screen.getByText('jarvis/T-12')).toBeInTheDocument();
    expect(screen.getByText('1.3M tokens · notional $1.50')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open thread' })).toHaveAttribute('href', '/chat/th-1');
    expect(screen.getByRole('link', { name: '#7' })).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/7',
    );
    for (const name of ['Retry stage', 'Stop worker', 'Cancel task']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }

    // timeline, with the repeated PR Open as its own span
    const timeline = screen.getByRole('list', { name: 'Stage timeline' });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(5);
    expect(within(timeline).getByText('again (×2)')).toBeInTheDocument();

    // artifacts
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'context.md',
      'spec.md',
      'plan.md',
      'tasks.md',
      'result.md',
    ]);
    expect(await screen.findByRole('heading', { name: 'Context' })).toBeInTheDocument();

    // PR · CI · Review
    const pr = screen.getByRole('region', { name: 'PR · CI · Review' });
    expect(within(pr).getByText('abcdef1')).toBeInTheDocument();
    expect(within(pr).getByText('Review: Changes requested')).toBeInTheDocument();
    expect(within(pr).getByText('CI fixes 1/2')).toBeInTheDocument();
    expect(within(pr).getByText('Review rounds 0/3')).toBeInTheDocument();
    expect(within(pr).getByText('unit tests')).toBeInTheDocument();
    expect(within(pr).getByRole('link', { name: 'Log for unit tests' })).toHaveAttribute(
      'href',
      'https://ci.example/unit',
    );
    expect(within(pr).getByText(/Earlier commits/)).toBeInTheDocument();
    expect(within(pr).getByText('handled')).toBeInTheDocument();
    expect(within(pr).getByText('ignored')).toBeInTheDocument();

    // runs
    const runs = screen.getByRole('region', { name: 'Runs' });
    expect(within(runs).getByText(/limit reached/)).toBeInTheDocument();
    expect(within(runs).getAllByRole('link', { name: 'worker' })[0]).toHaveAttribute(
      'href',
      '/sessions/ses-1?run=run-1',
    );
    expect(within(runs).getByRole('columnheader', { name: 'Notional $' })).toBeInTheDocument();

    // journal, chronological, with the owner mark
    const journal = screen.getByRole('list', { name: 'Task journal' });
    const entries = within(journal).getAllByRole('listitem');
    expect(entries[0]).toHaveTextContent('Entered Context');
    expect(entries[1]).toHaveTextContent('Retried the stage');
    expect(within(entries[1] as HTMLElement).getByText('by owner')).toBeInTheDocument();
    expect(entries[0]).not.toHaveTextContent('by owner');
  });

  it('renders a table in an artifact and the empty state of a missing file', async () => {
    renderDetail({
      'GET /api/tasks/T-12': taskDetail(),
      'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact(''), name: 'context.md' },
      'GET /api/tasks/T-12/artifacts/spec.md': specArtifact(
        '| Req | Status |\n| --- | --- |\n| R-1 | open |',
      ),
    });
    await screen.findByRole('tab', { name: 'spec.md' });
    await userEvent.click(screen.getByRole('tab', { name: 'spec.md' }));
    expect(await screen.findByRole('cell', { name: 'R-1' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Req' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'plan.md' }));
    expect(screen.getByText('Not written yet — appears at stage Spec Review')).toBeInTheDocument();
  });

  it('marks an artifact that changed while it is open', async () => {
    let content = 'first version';
    const { queryClient } = renderDetail({
      'GET /api/tasks/T-12': taskDetail(),
      'GET /api/tasks/T-12/artifacts/context.md': () => ({
        ...specArtifact(content),
        name: 'context.md',
      }),
    });
    expect(await screen.findByText('first version')).toBeInTheDocument();
    expect(screen.queryByText('Updated just now')).not.toBeInTheDocument();

    content = 'second version';
    await act(() => queryClient.invalidateQueries({ queryKey: ['tasks'] }));
    expect(await screen.findByText('second version')).toBeInTheDocument();
    expect(screen.getByText('Updated just now')).toBeInTheDocument();
  });

  it('shows an error inside the artifact block only', async () => {
    renderDetail({
      'GET /api/tasks/T-12': taskDetail(),
      'GET /api/tasks/T-12/artifacts/context.md': {
        status: 500,
        body: { code: 'boom', message: 'Disk gone' },
      },
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load context.md');
    expect(screen.getByRole('heading', { name: 'Add the export page' })).toBeInTheDocument();
  });

  it('cancels the task only after confirmation', async () => {
    const { spy } = renderDetail({
      'GET /api/tasks/T-12': taskDetail({ stage: 'Implementing' }),
      'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact('x'), name: 'context.md' },
      'POST /api/tasks/T-12/cancel': {},
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel T-12?' });
    expect(posts(spy)).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(posts(spy)).toEqual(['/api/tasks/T-12/cancel']));
  });

  it('stops the worker after confirmation while a run is running', async () => {
    const { spy } = renderDetail({
      'GET /api/tasks/T-12': taskDetail({ runs: [run({ status: 'running', endedAt: null })] }),
      'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact('x'), name: 'context.md' },
      'POST /api/tasks/T-12/stop': {},
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Stop worker' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop worker' }));
    await waitFor(() => expect(posts(spy)).toEqual(['/api/tasks/T-12/stop']));
  });

  it('shows the reason and a working Retry stage for a Failed task', async () => {
    const { spy } = renderDetail({
      'GET /api/tasks/T-12': taskDetail({
        stage: 'Failed',
        reason: 'Checks failed three times',
        runs: [run({ status: 'failed', error: 'tests red' })],
      }),
      'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact('x'), name: 'context.md' },
      'POST /api/tasks/T-12/retry': {},
    });
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Failed: Checks failed three times');
    expect(within(note).getByRole('list', { name: 'Last attempts' })).toHaveTextContent(
      'tests red',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry stage' }));
    await waitFor(() => expect(posts(spy)).toEqual(['/api/tasks/T-12/retry']));
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeDisabled();
  });

  it('opens the artifact named in ?artifact=', async () => {
    renderDetail(
      {
        'GET /api/tasks/T-12': taskDetail(),
        'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact('x'), name: 'context.md' },
      },
      'T-12',
      '?artifact=result.md',
    );
    const tab = await screen.findByRole('tab', { name: 'result.md' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it.each([
    ['Failed', true],
    ['Intake', true],
    ['Context', true],
    ['Implementing', true],
    ['Verifying', true],
    ['Reviewing', true],
    ['Fixing', true],
    ['Spec Review', false],
    ['Blocked', false],
    ['PR Open', false],
    ['Done', false],
    ['Cancelled', false],
  ] as const)('Retry stage in %s is enabled: %s (matches the engine)', async (stage, enabled) => {
    renderDetail({
      'GET /api/tasks/T-12': taskDetail({ stage }),
      'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact('x'), name: 'context.md' },
    });
    const retry = await screen.findByRole('button', { name: 'Retry stage' });
    await waitFor(() => (enabled ? expect(retry).toBeEnabled() : expect(retry).toBeDisabled()));
  });

  it('disables every action for a Cancelled task', async () => {
    renderDetail({
      'GET /api/tasks/T-12': taskDetail({ stage: 'Cancelled' }),
      'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact('x'), name: 'context.md' },
    });
    await screen.findByRole('heading', { name: 'Add the export page' });
    for (const name of ['Retry stage', 'Stop worker', 'Cancel task']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByText('Task cancelled — actions are disabled.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#7' })).toBeInTheDocument();
  });

  it('disables Retry stage while the daily budget is used up', async () => {
    renderDetail({
      'GET /api/overview': overview({ usage: usage({ paused: true }) }),
      'GET /api/tasks/T-12': taskDetail({ stage: 'Failed', reason: 'x' }),
      'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact('x'), name: 'context.md' },
    });
    const retry = await screen.findByRole('button', { name: 'Retry stage' });
    await waitFor(() => expect(retry).toBeDisabled());
    expect(retry).toHaveAccessibleDescription(/daily budget/);
  });

  it('disables actions when the engine is not reachable', async () => {
    renderDetail({
      'GET /api/tasks/T-12': taskDetail({ stage: 'Implementing' }),
      'GET /api/tasks/T-12/artifacts/context.md': { ...specArtifact('x'), name: 'context.md' },
    });
    await screen.findByRole('heading', { name: 'Add the export page' });
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeEnabled();
    FakeEventSource.current.fail();
    expect(await screen.findByRole('button', { name: 'Cancel task' })).toBeDisabled();
  });

  it('shows Not found for an unknown task', async () => {
    renderDetail({}, 'T-404');
    expect(await screen.findByRole('heading', { name: 'Task not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Tasks' })).toHaveAttribute('href', '/tasks');
  });
});
