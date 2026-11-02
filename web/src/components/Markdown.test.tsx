import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders formatting as elements', () => {
    render(<Markdown>{'# Title\n\nSome **bold** text'}</Markdown>);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('shows raw HTML as inert text, never as elements (SEC-03)', () => {
    const { container } = render(
      <Markdown>{'<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">'}</Markdown>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(1)</script>');
    expect(container).toHaveTextContent('<img src=x onerror="alert(2)">');
  });

  it('opens links in a new tab without a referrer', () => {
    render(<Markdown>{'[docs](https://example.com/a)'}</Markdown>);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('drops javascript: URLs', () => {
    render(<Markdown>{'[x](javascript:alert(1))'}</Markdown>);
    expect(screen.getByText('x').closest('a')).not.toHaveAttribute(
      'href',
      expect.stringMatching(/^javascript:/),
    );
  });

  it('renders task-list items as disabled checkboxes', () => {
    render(<Markdown>{'- [x] done thing\n- [ ] open thing\n- plain'}</Markdown>);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[1]).toBeDisabled();
    expect(screen.getByText('done thing')).toBeInTheDocument();
    expect(screen.getByText('plain')).toBeInTheDocument();
  });

  it('renders tables', () => {
    render(<Markdown>{'| Step | Status |\n| --- | --- |\n| Build | ok |'}</Markdown>);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Step' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Build' })).toBeInTheDocument();
  });

  it('renders task-list items of a loose list', () => {
    render(<Markdown>{'- [x] first\n\n- [ ] second'}</Markdown>);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });
});
