import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_BODY_MAX_BYTES,
  CapabilityNameSchema,
  McpServerItemSchema,
  OwnerAgentInputSchema,
  OwnerSkillInputSchema,
} from './capabilities.js';

describe('CapabilityNameSchema', () => {
  it.each(['a', 'my-skill', '0-day', 'a'.repeat(64)])('accepts %s', (name) => {
    expect(CapabilityNameSchema.safeParse(name).success).toBe(true);
  });
  it.each(['', '-x', 'A', 'a_b', 'a/b', '..', 'a b', 'a'.repeat(65)])('rejects %j', (name) => {
    expect(CapabilityNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('owner inputs', () => {
  it('requires a non-empty one-line description of at most 1024 characters', () => {
    const ok = { description: 'Does a thing', body: '# x' };
    expect(OwnerSkillInputSchema.safeParse(ok).success).toBe(true);
    expect(OwnerSkillInputSchema.safeParse({ ...ok, description: '  ' }).success).toBe(false);
    expect(OwnerSkillInputSchema.safeParse({ ...ok, description: 'a\nb' }).success).toBe(false);
    expect(OwnerSkillInputSchema.safeParse({ ...ok, description: 'a'.repeat(1025) }).success).toBe(
      false,
    );
  });

  it('limits the body in bytes, not characters', () => {
    const base = { description: 'd' };
    const atLimit = 'a'.repeat(CAPABILITY_BODY_MAX_BYTES);
    expect(OwnerSkillInputSchema.safeParse({ ...base, body: atLimit }).success).toBe(true);
    expect(OwnerSkillInputSchema.safeParse({ ...base, body: `${atLimit}a` }).success).toBe(false);
    expect(
      OwnerSkillInputSchema.safeParse({
        ...base,
        body: 'é'.repeat(CAPABILITY_BODY_MAX_BYTES / 2 + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields, so a skill cannot carry a model', () => {
    expect(
      OwnerSkillInputSchema.safeParse({ description: 'd', body: '', model: 'opus' }).success,
    ).toBe(false);
  });

  it('subagent: model from the allowed set, tools non-empty and comma-free', () => {
    const base = { description: 'd', body: '' };
    expect(
      OwnerAgentInputSchema.safeParse({ ...base, model: 'opus', tools: ['Read'] }).success,
    ).toBe(true);
    expect(OwnerAgentInputSchema.safeParse({ ...base, model: 'gpt' }).success).toBe(false);
    expect(OwnerAgentInputSchema.safeParse({ ...base, tools: [''] }).success).toBe(false);
    expect(OwnerAgentInputSchema.safeParse({ ...base, tools: ['Read, Write'] }).success).toBe(
      false,
    );
  });
});

describe('McpServerItemSchema', () => {
  it('has no field that could carry a value of an environment variable', () => {
    expect(Object.keys(McpServerItemSchema.shape)).not.toContain('env');
  });
});
