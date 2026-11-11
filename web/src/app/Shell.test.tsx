import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useCanMutate } from '../api/queries';
import { stubFetch } from '../test/fakeFetch';
import { FakeEventSource } from '../test/FakeEventSource';
import { overview, thread, usage } from '../test/fixtures';
import { renderApp, renderWithProviders } from '../test/renderWithProviders';

const connections = { billingEnvDetected: false, claudeSubscription: true, connections: [] };

function routes(patch: Record<string, unknown> = {}) {
  return stubFetch({
    'GET /api/overview': overview(),
    'GET /api/threads': [],
    'GET /api/connections': connections,
    ...patch,
  });
}

describe('Shell', () => {
  it('redirects / to /chat and shows the product, local marker and navigation', async () => {
    routes();
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Опишіть задачу або поставте питання' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Jarvis')).toBeInTheDocument();
    expect(screen.getByText('LOCAL · NO AUTH')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const name of [
      'Chat',
      'Overview',
      'Tasks',
      'Capabilities',
      'Usage',
      'Config',
      'Connections',
    ]) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('navigates between screens', async () => {
    routes();
    renderApp({ route: '/chat' });
    await userEvent.click(await screen.findByRole('link', { name: 'Tasks' }));
    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('renders Not found for an unknown path', async () => {
    routes();
    renderApp({ route: '/nope' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows the compact usage meter linking to /config', async () => {
    routes();
    renderApp({ route: '/tasks' });
    const meter = await screen.findByRole('link', { name: /3\.2M \/ 20M tokens today/ });
    expect(meter).toHaveAttribute('href', '/config');
  });

  it('counts threads waiting for the owner and links to the oldest', async () => {
    routes({
      'GET /api/threads': [
        thread({ id: 'new', waitingForOwner: true, lastActivityAt: '2026-10-26T12:00:00.000Z' }),
        thread({ id: 'old', waitingForOwner: true, lastActivityAt: '2026-10-26T08:00:00.000Z' }),
        thread({ id: 'idle', waitingForOwner: false, lastActivityAt: '2026-10-25T08:00:00.000Z' }),
      ],
    });
    renderApp({ route: '/tasks' });
    const counter = await screen.findByRole('link', { name: 'Waiting for you: 2' });
    expect(counter).toHaveAttribute('href', '/chat/old');
  });

  it('shows the budget banner when paused', async () => {
    routes({
      'GET /api/overview': overview({ usage: usage({ todayTokens: 20_000_000, paused: true }) }),
    });
    renderApp({ route: '/tasks' });
    expect(await screen.findByText('Paused: daily budget reached')).toBeInTheDocument();
  });

  it('warns about API billing when ANTHROPIC_API_KEY is detected', async () => {
    routes({
      'GET /api/connections': {
        billingEnvDetected: true,
        claudeSubscription: null,
        connections: [],
      },
    });
    renderApp({ route: '/tasks' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/ANTHROPIC_API_KEY/);
  });

  it('warns about API billing when the login is not the subscription', async () => {
    routes({
      'GET /api/connections': {
        billingEnvDetected: false,
        claudeSubscription: false,
        connections: [],
      },
    });
    renderApp({ route: '/tasks' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/not your subscription/);
  });

  it('shows the connection state and the offline banner, then recovers', async () => {
    routes();
    renderApp({ route: '/tasks' });
    await screen.findByRole('heading', { name: 'Tasks' });
    expect(screen.queryByText(/Changes are disabled/)).toBeInTheDocument(); // not live before open

    FakeEventSource.current.open();
    expect(await screen.findByRole('status', { name: 'Engine connection' })).toHaveTextContent(
      'Live',
    );
    expect(screen.queryByText(/Changes are disabled/)).not.toBeInTheDocument();

    FakeEventSource.current.fail(true);
    expect(await screen.findByText(/Changes are disabled/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Engine connection' })).toHaveTextContent('Offline');
    expect(screen.getByText(/Last seen/)).toBeInTheDocument();
  });
});

describe('useCanMutate', () => {
  function Probe() {
    return <button disabled={!useCanMutate()}>Send</button>;
  }

  it('disables mutations until the stream is live and while it is down', () => {
    renderWithProviders(<Probe />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    FakeEventSource.current.open();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    FakeEventSource.current.fail();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
