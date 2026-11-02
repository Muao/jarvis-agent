import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function setup(open = true) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open={open}
      title="Cancel task T-12?"
      description="The worker stops and the branch stays."
      confirmLabel="Cancel task"
      cancelLabel="Keep running"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('renders nothing while closed', () => {
    setup(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a named, described dialog when open', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Cancel task T-12?' });
    expect(dialog).toHaveAccessibleDescription('The worker stops and the branch stays.');
  });

  it('focuses the safe choice first', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Keep running' })).toHaveFocus();
  });

  it('confirms and cancels through its buttons', async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('treats Esc (the dialog cancel event) as cancel', () => {
    const { onCancel, onConfirm } = setup();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
