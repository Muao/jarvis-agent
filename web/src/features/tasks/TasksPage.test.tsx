import { Route, Routes } from 'react-router';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { stubFetch } from '../../test/fakeFetch';
import { renderWithProviders } from '../../test/renderWithProviders';
import { task } from './fixtures';
import { TasksPage } from './TasksPage';

const tasks = [
  task({ id: 'T-1', title: 'Fix login', stage: 'Implementing', waitingFor: '—' }),
  task({ id: 'T-2', title: 'Write docs', stage: 'Spec Review', waitingFor: 'owner' }),
  task({
    id: 'T-3',
    title: 'Ship export',
    stage: 'Done',
    prNumber: 9,
    prUrl: 'https://github.com/o/r/pull/9',
    ci: 'passed',
  }),
  task({ id: 'T-4', title: 'Broken migration', stage: 'Failed' }),
  task({ id: 'T-5', title: 'Old idea', stage: 'Cancelled' }),
];

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/tasks/:taskId" element={<p>detail page</p>} />
    </Routes>,
    { route: '/tasks' },
  );
}

const rowTitles = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.textContent);

describe('TasksPage', () => {
  it('lists tasks with every column and notional money', async () => {
    stubFetch({ 'GET /api/tasks': tasks });
    renderPage();
    expect(await screen.findByRole('cell', { name: 'Fix login' })).toBeInTheDocument();
    for (const name of [
      'ID',
      'Title',
      'Stage',
      'Waiting for',
      'Branch',
      'PR',
      'CI',
      'Runs',
      'Notional $',
      'Updated',
    ]) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    const done = screen.getByRole('row', { name: /T-3/ });
    expect(within(done).getByRole('link', { name: '#9' })).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/9',
    );
    expect(done).toHaveTextContent('passed');
    expect(done).toHaveTextContent('$1.50');
  });

  it.each([
    ['Active', ['Fix login']],
    ['Waiting', ['Write docs']],
    ['Done', ['Ship export']],
    ['Failed', ['Broken migration']],
    ['Cancelled', ['Old idea']],
  ])('filters by %s', async (filter, expected) => {
    stubFetch({ 'GET /api/tasks': tasks });
    renderPage();
    await screen.findByRole('cell', { name: 'Fix login' });
    await userEvent.click(screen.getByRole('button', { name: filter }));
    expect(screen.getByRole('button', { name: filter })).toHaveAttribute('aria-pressed', 'true');
    expect(rowTitles()).toEqual(expected);
  });

  it('searches by title or ID', async () => {
    stubFetch({ 'GET /api/tasks': tasks });
    renderPage();
    await screen.findByRole('cell', { name: 'Fix login' });
    const search = screen.getByRole('searchbox', { name: 'Search by title or ID' });

    await userEvent.type(search, 'export');
    expect(rowTitles()).toEqual(['Ship export']);

    await userEvent.clear(search);
    await userEvent.type(search, 't-4');
    expect(rowTitles()).toEqual(['Broken migration']);

    await userEvent.clear(search);
    await userEvent.type(search, 'nothing like this');
    expect(screen.getByRole('heading', { name: 'No tasks match' })).toBeInTheDocument();
  });

  it('opens the detail page on a row click', async () => {
    stubFetch({ 'GET /api/tasks': tasks });
    renderPage();
    await userEvent.click(await screen.findByRole('cell', { name: 'Fix login' }));
    expect(await screen.findByText('detail page')).toBeInTheDocument();
  });

  it('shows the empty state with a link to Chat', async () => {
    stubFetch({ 'GET /api/tasks': [] });
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Ще немає задач. Поставте першу в Chat' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Відкрити Chat' })).toHaveAttribute('href', '/chat');
  });

  it('shows loading, then an error with retry', async () => {
    stubFetch({
      'GET /api/tasks': { status: 500, body: { code: 'boom', message: 'Engine broke' } },
    });
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading tasks…');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load tasks');
    expect(alert).toHaveTextContent('Engine broke');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
