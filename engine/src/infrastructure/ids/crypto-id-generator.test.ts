import { describe, expect, it } from 'vitest';
import { CryptoIdGenerator } from './crypto-id-generator.js';

describe('CryptoIdGenerator', () => {
  const ids = new CryptoIdGenerator();

  it('makes distinct UUIDs', () => {
    const all = [ids.threadId(), ids.messageId(), ids.sessionId(), ids.runId(), ids.permissionId()];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });

  it('makes unguessable URL-safe tokens of 256 bits', () => {
    const token = ids.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ids.token()).not.toBe(token);
  });
});
