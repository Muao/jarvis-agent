import { describe, expect, it } from 'vitest';
import { listField, parseFrontmatter, serializeFrontmatter, textField } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('reads key: value lines and the body after the closing fence', () => {
    const parsed = parseFrontmatter(
      '---\nname: reviewer\ndescription: Reviews a diff.\ntools: Read, Glob, Grep\nmodel: sonnet\n---\n\n# Body\n',
    );
    expect(parsed?.fields).toEqual({
      name: 'reviewer',
      description: 'Reviews a diff.',
      tools: 'Read, Glob, Grep',
      model: 'sonnet',
    });
    expect(parsed?.body).toBe('\n# Body\n');
    expect(listField(parsed?.fields['tools'])).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('returns null without a frontmatter block', () => {
    expect(parseFrontmatter('# just markdown')).toBeNull();
    expect(parseFrontmatter('---\nname: x\nno closing fence')).toBeNull();
  });

  it('reads quoted values, folded blocks and lists as found in the wild', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        'name: "quoted"',
        "other: 'it''s'",
        'description: >',
        '  one',
        '  two',
        'tools:',
        '  - Read',
        '  - Bash',
        'flow: [A, "B"]',
        '---',
        'x',
      ].join('\n'),
    );
    expect(parsed?.fields).toEqual({
      name: 'quoted',
      other: "it's",
      description: 'one two',
      tools: ['Read', 'Bash'],
      flow: ['A', 'B'],
    });
  });

  it('copes with CRLF', () => {
    const parsed = parseFrontmatter('---\r\nname: a\r\n---\r\nbody');
    expect(textField(parsed?.fields['name'])).toBe('a');
  });
});

describe('serializeFrontmatter', () => {
  it('round-trips a description that would break plain YAML', () => {
    const description = 'Use when: the user says "go" # not a comment';
    const text = serializeFrontmatter({
      name: 'x',
      description,
      tools: ['Read', 'Bash(git status:*)'],
      model: 'haiku',
      body: '# Title\nline',
    });
    const parsed = parseFrontmatter(text);
    expect(parsed?.fields['description']).toBe(description);
    expect(listField(parsed?.fields['tools'])).toEqual(['Read', 'Bash(git status:*)']);
    expect(parsed?.fields['model']).toBe('haiku');
    expect(parsed?.body.replace(/^\n/, '')).toBe('# Title\nline\n');
  });

  it('leaves out tools and model when not given', () => {
    const text = serializeFrontmatter({ name: 'x', description: 'd', body: '' });
    expect(text).toBe('---\nname: x\ndescription: "d"\n---\n\n');
  });
});
