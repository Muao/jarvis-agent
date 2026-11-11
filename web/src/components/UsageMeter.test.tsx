import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeEventSource } from '../test/FakeEventSource';
import { stubFetch } from '../test/fakeFetch';
import { renderWithProviders } from '../test/renderWithProviders';
import { usage } from '../test/fixtures';
import { UsageMeter } from './UsageMeter';

describe('UsageMeter', () => {
  it('compact: shows the tokens used, links to /config, no warning', () => {
    renderWithProviders(<UsageMeter usage={usage()} />);
    const link = screen.getByRole('link', { name: /3\.2M \/ 20M tokens today/ });
    expect(link).toHaveAttribute('href', '/config');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '16');
    expect(screen.queryByText(/Near limit|Paused/)).not.toBeInTheDocument();
  });

  it('warns from 80 %', () => {
    renderWithProviders(<UsageMeter usage={usage({ todayTokens: 16_000_000 })} />);
    expect(screen.getByText('Near limit (80%)')).toBeInTheDocument();
  });

  it('shows Paused when the budget is reached', () => {
    renderWithProviders(
      <UsageMeter usage={usage({ todayTokens: 25_000_000, paused: true })} variant="full" />,
    );
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    expect(screen.getByText(/Resets/)).toBeInTheDocument();
  });

  describe('Reset', () => {
    it('asks first and posts nothing when cancelled', async () => {
      const fetch = stubFetch({});
      renderWithProviders(<UsageMeter usage={usage()} />);
      FakeEventSource.current.open();
      await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(fetch).not.toHaveBeenCalled();
    });

    it('posts the reset after confirming', async () => {
      const fetch = stubFetch({ 'POST /api/usage/reset': usage({ todayTokens: 0 }) });
      renderWithProviders(<UsageMeter usage={usage()} />);
      FakeEventSource.current.open();
      await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Reset usage' }));
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          '/api/usage/reset',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
    });

    it('is disabled while the engine is not live', () => {
      renderWithProviders(<UsageMeter usage={usage()} />);
      expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    });
  });
});
