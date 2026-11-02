import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Collapsible } from './Collapsible';
import { EmptyState } from './EmptyState';
import { ErrorBlock } from './ErrorBlock';
import { Loading } from './Loading';
import { formatRelative, RelativeTime } from './RelativeTime';

describe('Collapsible', () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

  it('shows the first lines and expands on demand', async () => {
    render(<Collapsible text={text} maxLines={3} />);
    expect(screen.queryByText(/line 4/)).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Show more/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);
    expect(screen.getByText(/line 20/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('has no toggle for short text', () => {
    render(<Collapsible text="one line" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ErrorBlock', () => {
  it('is an alert with the message and a working retry', async () => {
    const onRetry = vi.fn();
    render(<ErrorBlock title="Could not load tasks" error={new Error('boom')} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tasks');
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits Retry without a handler', () => {
    render(<ErrorBlock error="x" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('EmptyState and Loading', () => {
  it('renders title, description and action', () => {
    render(
      <EmptyState
        title="No tasks yet"
        description="Start one in Chat"
        action={<a href="/chat">Open Chat</a>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument();
    expect(screen.getByText('Start one in Chat')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Chat' })).toBeInTheDocument();
  });

  it('announces loading', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});

describe('RelativeTime', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');

  it('formats past and future instants', () => {
    expect(formatRelative(new Date('2026-10-26T11:59:40.000Z'), now)).toBe('just now');
    expect(formatRelative(new Date('2026-10-26T11:55:00.000Z'), now)).toBe('5 minutes ago');
    expect(formatRelative(new Date('2026-10-26T09:00:00.000Z'), now)).toBe('3 hours ago');
    expect(formatRelative(new Date('2026-10-27T00:00:00.000Z'), now)).toBe('in 12 hours');
    expect(formatRelative(new Date('2026-10-25T12:00:00.000Z'), now)).toBe('yesterday');
  });

  it('is independent of the offset written in the string', () => {
    render(<RelativeTime at="2026-10-26T14:00:00+02:00" now={now} />);
    const time = screen.getByText('just now');
    expect(time).toHaveAttribute('datetime', '2026-10-26T12:00:00.000Z');
  });

  it('falls back to the raw text for an invalid date', () => {
    render(<RelativeTime at="soon" now={now} />);
    expect(screen.getByText('soon')).toBeInTheDocument();
  });
});
