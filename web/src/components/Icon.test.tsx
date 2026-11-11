import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon';

describe('Icon', () => {
  it('is decorative and hidden from assistive tech without a label', () => {
    const { container } = render(<Icon name="chat" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('is an image with an accessible name when labelled', () => {
    render(<Icon name="warning" label="Warning" />);
    expect(screen.getByRole('img', { name: 'Warning' })).toBeInTheDocument();
  });
});
