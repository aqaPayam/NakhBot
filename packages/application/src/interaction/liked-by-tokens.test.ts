import { describe, expect, it } from 'vitest';

import type { OpaqueTokenStore } from '../security/opaque-token.js';
import { LikedByOpaqueReferences } from './liked-by-tokens.js';

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

const receiverId = '10000000-0000-4000-8000-000000000001';
const anotherReceiverId = '10000000-0000-4000-8000-000000000002';
const likeId = '20000000-0000-4000-8000-000000000001';
const position = { createdAt: new Date('2026-01-02T03:04:05.000Z'), likeId };
const key = new Uint8Array(32).fill(7);

describe('Liked By opaque references', () => {
  it('issues short signed cursor and action references without leaking internal identifiers', async () => {
    const store = new MemoryTokens();
    let id = 0;
    const tokens = new LikedByOpaqueReferences(
      store,
      key,
      () => 1_000,
      () => (id++ === 0 ? 'abcdefghijklmnop' : 'ponmlkjihgfedcba'),
    );
    const cursor = await tokens.issueCursor(receiverId, position);
    const action = await tokens.issueAction(receiverId, likeId);

    expect(cursor).toMatch(/^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u);
    expect(cursor.length).toBeLessThanOrEqual(64);
    expect(action.length).toBeLessThanOrEqual(64);
    for (const token of [cursor, action]) {
      expect(token).not.toContain(receiverId);
      expect(token).not.toContain(likeId);
      expect(token).not.toContain(position.createdAt.toISOString());
    }
    await expect(tokens.resolveCursor(cursor, receiverId)).resolves.toEqual(position);
    await expect(tokens.resolveAction(action, receiverId)).resolves.toBe(likeId);
    await expect(tokens.resolveAction(cursor, receiverId)).resolves.toBeUndefined();
    await expect(tokens.resolveCursor(action, receiverId)).resolves.toBeUndefined();
    const storedCursor = JSON.parse(store.values.get('abcdefghijklmnop')!) as Record<
      string,
      unknown
    >;
    store.values.set('abcdefghijklmnop', JSON.stringify({ ...storedCursor, queryVersion: 2 }));
    await expect(tokens.resolveCursor(cursor, receiverId)).resolves.toBeUndefined();
  });

  it('denies tampering, another receiver, a different signing key, and expiry', async () => {
    let now = 1_000;
    const store = new MemoryTokens();
    const tokens = new LikedByOpaqueReferences(
      store,
      key,
      () => now,
      () => 'abcdefghijklmnop',
    );
    const cursor = await tokens.issueCursor(receiverId, position);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    await expect(tokens.resolveCursor(tampered, receiverId)).resolves.toBeUndefined();
    await expect(tokens.resolveCursor(cursor, anotherReceiverId)).resolves.toBeUndefined();
    await expect(
      new LikedByOpaqueReferences(store, new Uint8Array(32).fill(8)).resolveCursor(
        cursor,
        receiverId,
      ),
    ).resolves.toBeUndefined();
    now = 901_000;
    await expect(tokens.resolveCursor(cursor, receiverId)).resolves.toBeUndefined();
  });

  it('fails closed for missing or malformed state and bounded allocation collisions', async () => {
    const store = new MemoryTokens();
    const tokens = new LikedByOpaqueReferences(
      store,
      key,
      () => 1_000,
      () => 'abcdefghijklmnop',
    );
    const action = await tokens.issueAction(receiverId, likeId);
    store.values.set('abcdefghijklmnop', '{bad');
    await expect(tokens.resolveAction(action, receiverId)).resolves.toBeUndefined();
    store.values.set('abcdefghijklmnop', JSON.stringify({ purpose: 'liked_by_action' }));
    await expect(tokens.resolveAction(action, receiverId)).resolves.toBeUndefined();
    store.values.clear();
    await expect(tokens.resolveAction(action, receiverId)).resolves.toBeUndefined();
    store.values.set('abcdefghijklmnop', '{}');
    await expect(tokens.issueAction(receiverId, likeId)).rejects.toThrow('allocation failed');
    await expect(tokens.issueAction('invalid', likeId)).rejects.toThrow('state is invalid');
    expect(() => new LikedByOpaqueReferences(store, new Uint8Array(31))).toThrow('key is invalid');
  });
});
