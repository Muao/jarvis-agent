import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { usage } from '../test/fixtures';
import { UsageMeter } from './UsageMeter';

const renderMeter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('UsageMeter', () => {
  it('compact: shows notional spend, links to /config, no warning', () => {
    renderMeter(<UsageMeter usage={usage()} />);
    const link = screen.getByRole('link', { name: /notional \$3\.20 \/ \$20\.00 today/ });
    expect(link).toHaveAttribute('href', '/config');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '16');
    expect(screen.queryByText(/Near limit|Paused/)).not.toBeInTheDocument();
  });

  it('warns from 80 %', () => {
    renderMeter(<UsageMeter usage={usage({ todayUsd: 16 })} />);
    expect(screen.getByText('Near limit (80%)')).toBeInTheDocument();
  });

  it('shows Paused when the budget is reached', () => {
    renderMeter(<UsageMeter usage={usage({ todayUsd: 25, paused: true })} variant="full" />);
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/Resets/)).toBeInTheDocument();
  });
});
