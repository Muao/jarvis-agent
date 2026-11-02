import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ConnectionsDto } from '@jarvis/shared';
import { stubFetch } from '../../test/fakeFetch';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ConnectionsPage } from './ConnectionsPage';

const AT = '2026-10-26T10:00:00.000Z';

const data = (patch: Partial<ConnectionsDto> = {}): ConnectionsDto => ({
  billingEnvDetected: false,
  claudeSubscription: true,
  connections: [
    {
      id: 'claude',
      status: 'ok',
      summary: 'Logged in · Max',
      details: [{ label: 'Version', value: '2.1.0' }],
      checkedAt: AT,
    },
    {
      id: 'github',
      status: 'failed',
      summary: 'Token rejected',
      details: [{ label: 'Account', value: 'jarvis-bot' }],
      checkedAt: AT,
    },
    { id: 'notion', status: 'not_configured', summary: '', details: [], checkedAt: null },
    { id: 'slack', status: 'disabled', summary: '', details: [], checkedAt: null },
  ],
  ...patch,
});

describe('ConnectionsPage', () => {
  it('renders a row per connection with status, details and an inactive Slack row', async () => {
    stubFetch({ 'GET /api/connections': data() });
    renderWithProviders(<ConnectionsPage />);

    const claude = await screen.findByRole('listitem', { name: 'Claude CLI' });
    expect(within(claude).getByText(/Connected/)).toBeInTheDocument();
    expect(within(claude).getByText('2.1.0')).toBeInTheDocument();
    expect(within(claude).queryByRole('alert')).not.toBeInTheDocument();

    const github = screen.getByRole('listitem', { name: 'GitHub' });
    expect(within(github).getByText(/Error/)).toBeInTheDocument();
    expect(within(github).getByText('jarvis-bot')).toBeInTheDocument();

    expect(
      within(screen.getByRole('listitem', { name: 'Notion' })).getByText('Not configured'),
    ).toBeInTheDocument();

    const slack = screen.getByRole('listitem', { name: 'Slack' });
    expect(within(slack).getByText('Iteration 2')).toBeInTheDocument();
    expect(within(slack).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a red warning on the Claude row when an API key is in the environment', async () => {
    stubFetch({ 'GET /api/connections': data({ billingEnvDetected: true }) });
    renderWithProviders(<ConnectionsPage />);
    const claude = await screen.findByRole('listitem', { name: 'Claude CLI' });
    expect(within(claude).getByRole('alert')).toHaveTextContent(/API billing detected/);
    expect(
      within(screen.getByRole('listitem', { name: 'GitHub' })).queryByRole('alert'),
    ).toBeNull();
  });

  it('warns when the login is not the subscription, and not for an unknown login', async () => {
    stubFetch({ 'GET /api/connections': data({ claudeSubscription: false }) });
    const first = renderWithProviders(<ConnectionsPage />);
    const claude = await screen.findByRole('listitem', { name: 'Claude CLI' });
    expect(within(claude).getByRole('alert')).toHaveTextContent(/API billing detected/);
    first.unmount();

    stubFetch({ 'GET /api/connections': data({ claudeSubscription: null }) });
    renderWithProviders(<ConnectionsPage />);
    const again = await screen.findByRole('listitem', { name: 'Claude CLI' });
    expect(within(again).queryByRole('alert')).toBeNull();
  });

  it('refetches on Check again', async () => {
    const user = userEvent.setup();
    const spy = stubFetch({ 'GET /api/connections': data() });
    renderWithProviders(<ConnectionsPage />);
    const github = await screen.findByRole('listitem', { name: 'GitHub' });
    expect(spy).toHaveBeenCalledTimes(1);
    await user.click(within(github).getByRole('button', { name: /Check again/ }));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
