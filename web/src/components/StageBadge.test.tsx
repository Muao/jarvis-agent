import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TASK_STAGES, TERMINAL_STAGES } from '@jarvis/shared';
import { StageBadge } from './StageBadge';

describe('StageBadge', () => {
  it.each(TASK_STAGES)('shows the %s stage as text', (stage) => {
    render(<StageBadge stage={stage} />);
    expect(screen.getByText(stage)).toBeInTheDocument();
  });

  it('shows PR Open as Thinking while the worker answers the owner', () => {
    render(<StageBadge stage="PR Open" working />);
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('PR Open')).not.toBeInTheDocument();
  });

  it.each(['Fixing', 'Implementing'] as const)(
    'keeps %s as it is while the worker runs',
    (stage) => {
      render(<StageBadge stage={stage} working />);
      expect(screen.getByText(stage)).toBeInTheDocument();
    },
  );

  it('gives every stage its own symbol, so colour is never the only cue', () => {
    const symbols = TASK_STAGES.map((stage) => {
      const { container, unmount } = render(<StageBadge stage={stage} />);
      const symbol = container.querySelector('[aria-hidden="true"]')?.textContent;
      unmount();
      return symbol;
    });
    expect(symbols.every(Boolean)).toBe(true);
    expect(new Set(symbols).size).toBe(TASK_STAGES.length);
  });

  it('marks Done, Failed and Cancelled with distinct terminal symbols', () => {
    const terminal = TERMINAL_STAGES.map((stage) => {
      const { container, unmount } = render(<StageBadge stage={stage} />);
      const symbol = container.querySelector('[aria-hidden="true"]')?.textContent;
      unmount();
      return symbol;
    });
    expect(terminal).toEqual(['✓', '✕', '⊘']);
  });
});
