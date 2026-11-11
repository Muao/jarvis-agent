import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ResizeHandle } from './ResizeHandle';
import { clampThreadListWidth, parseThreadListWidth } from './threadListWidth';

function Harness({ initial = 304 }: { initial?: number }) {
  const [value, setValue] = useState(initial);
  const [commits, setCommits] = useState<number[]>([]);
  return (
    <>
      <ResizeHandle
        label="Resize thread list"
        controls="list"
        value={value}
        min={224}
        max={512}
        defaultValue={304}
        onPreview={setValue}
        onCommit={(next) => {
          setValue(next);
          setCommits((all) => [...all, next]);
        }}
      />
      <output aria-label="commits">{commits.join(',')}</output>
    </>
  );
}

const handle = () => screen.getByRole('separator', { name: 'Resize thread list' });

describe('ResizeHandle', () => {
  it('exposes a named vertical separator with its value and bounds', () => {
    render(<Harness />);
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle()).toHaveAttribute('aria-valuenow', '304');
    expect(handle()).toHaveAttribute('aria-valuemin', '224');
    expect(handle()).toHaveAttribute('aria-valuemax', '512');
    expect(handle()).toHaveAttribute('aria-controls', 'list');
  });

  it('changes the width with the arrow keys, Shift for bigger steps, clamped to the bounds', async () => {
    render(<Harness />);
    handle().focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(handle()).toHaveAttribute('aria-valuenow', '320');
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(handle()).toHaveAttribute('aria-valuenow', '256');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    expect(handle()).toHaveAttribute('aria-valuenow', '224');
  });

  it('jumps to the bounds with Home and End and resets on double-click', async () => {
    render(<Harness />);
    handle().focus();
    await userEvent.keyboard('{End}');
    expect(handle()).toHaveAttribute('aria-valuenow', '512');
    await userEvent.keyboard('{Home}');
    expect(handle()).toHaveAttribute('aria-valuenow', '224');
    await userEvent.dblClick(handle());
    expect(handle()).toHaveAttribute('aria-valuenow', '304');
  });

  it('follows a pointer drag and commits once when it ends', () => {
    render(<Harness />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 100, pointerId: 1 });
    expect(handle()).toHaveFocus();
    fireEvent.pointerMove(handle(), { clientX: 150, pointerId: 1 });
    expect(handle()).toHaveAttribute('aria-valuenow', '354');
    fireEvent.pointerMove(handle(), { clientX: 900, pointerId: 1 });
    expect(handle()).toHaveAttribute('aria-valuenow', '512');
    expect(screen.getByLabelText('commits')).toHaveTextContent('');
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(screen.getByLabelText('commits')).toHaveTextContent(/^512$/);
    expect(document.body.style.getPropertyValue('user-select')).toBe('');
  });

  it('gives the page its text selection back when unmounted mid-drag', () => {
    const { unmount } = render(<Harness />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 100, pointerId: 1 });
    expect(document.body.style.getPropertyValue('user-select')).toBe('none');
    unmount();
    expect(document.body.style.getPropertyValue('user-select')).toBe('');
  });
});

describe('thread list width', () => {
  it('accepts only finite numbers and clamps them', () => {
    expect(parseThreadListWidth(400)).toBe(400);
    expect(parseThreadListWidth(10)).toBe(224);
    expect(parseThreadListWidth(9999)).toBe(512);
    expect(parseThreadListWidth('400')).toBeUndefined();
    expect(parseThreadListWidth(Number.NaN)).toBeUndefined();
    expect(clampThreadListWidth(300.4)).toBe(300);
  });
});
