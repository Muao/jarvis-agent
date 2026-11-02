import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StageStepper } from './StageStepper';

describe('StageStepper', () => {
  it('marks earlier steps done, the current step, and later steps pending', () => {
    render(<StageStepper stage="Verifying" />);
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      '✓Context (done)',
      '✓Spec (done)',
      '✓Impl (done)',
      '●Verify (current)',
      '○Review (pending)',
      '○PR (pending)',
    ]);
    expect(steps[3]).toHaveAttribute('aria-current', 'step');
  });

  it('shows repeats on the current step', () => {
    render(<StageStepper stage="Fixing" repeats={2} />);
    expect(screen.getByText('×3')).toBeInTheDocument();
  });

  it('marks every step done when the task is Done', () => {
    render(<StageStepper stage="Done" />);
    expect(screen.getAllByText('(done)', { exact: false })).toHaveLength(6);
  });

  it('shows where a failed task stopped', () => {
    render(<StageStepper stage="Failed" stoppedAt="Verifying" />);
    expect(screen.getByText('Verify').closest('li')).toHaveTextContent('✕Verify (stopped)');
  });
});
