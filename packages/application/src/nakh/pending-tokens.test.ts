import { describe, expect, it } from 'vitest';

import type { OpaqueTokenStore } from '../security/opaque-token.js';
import { PendingNakhOpaqueReferences } from './pending-tokens.js';

class MemoryTokens implements OpaqueTokenStore {
  public readonly values = new Map<string, string>();

  public putIfAbsent(id: string, value: string): Promise<boolean> {
    if (this.values.has(id)) return Promise.resolve(false);
    this.values.set(id, value);
    return Promise.resolve(true);
  }

  public get(id: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(id));
  }
}

const senderUserId = '10000000-0000-4000-8000-000000000001';
const anotherUserId = '10000000-0000-4000-8000-000000000002';
const pendingNakhId = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001';
const position = { createdAt: new Date('2026-09-22T00:00:00.000Z'), pendingNakhId };
const key = new Uint8Array(32).fill(9);

describe('Pending Nakh opaque references', () => {
  it('hides its position and resolves only for the issuing sender', async () => {
    const store = new MemoryTokens();
    const tokens = new PendingNakhOpaqueReferences(
      store,
      key,
      () => 1_000,
      () => 'abcdefghijklmnop',
    );
    const cursor = await tokens.issueCursor(senderUserId, position);
    expect(cursor).toMatch(/^v1\.pn\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u);
    expect(cursor).not.toContain(senderUserId);
    expect(cursor).not.toContain(pendingNakhId);
    expect(cursor).not.toContain(position.createdAt.toISOString());
    await expect(tokens.resolveCursor(cursor, senderUserId)).resolves.toEqual(position);
    await expect(tokens.resolveCursor(cursor, anotherUserId)).resolves.toBeUndefined();
  });

  it('denies tampering, another signing key, expiry, and malformed state', async () => {
    let now = 1_000;
    const store = new MemoryTokens();
    const tokens = new PendingNakhOpaqueReferences(
      store,
      key,
      () => now,
      () => 'abcdefghijklmnop',
    );
    const cursor = await tokens.issueCursor(senderUserId, position);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    await expect(tokens.resolveCursor(tampered, senderUserId)).resolves.toBeUndefined();
    await expect(
      new PendingNakhOpaqueReferences(store, new Uint8Array(32).fill(8)).resolveCursor(
        cursor,
        senderUserId,
      ),
    ).resolves.toBeUndefined();
    store.values.set('abcdefghijklmnop', '{bad');
    await expect(tokens.resolveCursor(cursor, senderUserId)).resolves.toBeUndefined();
    store.values.set('abcdefghijklmnop', JSON.stringify({ purpose: 'pending_nakh_cursor' }));
    await expect(tokens.resolveCursor(cursor, senderUserId)).resolves.toBeUndefined();
    now = 901_000;
    await expect(tokens.resolveCursor(cursor, senderUserId)).resolves.toBeUndefined();
    expect(() => new PendingNakhOpaqueReferences(store, new Uint8Array(31))).toThrow(
      'key is invalid',
    );
  });

  it('replays one stable cursor for a request and rejects a conflicting slot', async () => {
    const store = new MemoryTokens();
    let now = 1_000;
    const tokens = new PendingNakhOpaqueReferences(store, key, () => now);
    const first = await tokens.issueCursor(senderUserId, position, requestId);
    now = 2_000;
    await expect(tokens.issueCursor(senderUserId, position, requestId)).resolves.toBe(first);
    const occupied = new MemoryTokens();
    const colliding = new PendingNakhOpaqueReferences(
      occupied,
      key,
      () => 1_000,
      () => 'abcdefghijklmnop',
    );
    occupied.values.set('abcdefghijklmnop', '{}');
    await expect(colliding.issueCursor(senderUserId, position)).rejects.toThrow(
      'allocation failed',
    );
  });
});
