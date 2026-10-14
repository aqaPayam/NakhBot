import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisConnection, RedisOwnedOpaqueTokenStore } from './index.js';
import { LikedByOpaqueReferences } from '@nakh/application';

const url = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined)('M8 account-life opaque state revocation', () => {
  const redis = createRedisConnection(url ?? 'redis://invalid');
  const prefix = `m8-state-${randomUUID()}`;
  afterAll(async () => {
    await redis.quit();
  });
  function subject(
    userId: string = randomUUID(),
    productEpoch = 0,
  ): {
    userId: string;
    store: RedisOwnedOpaqueTokenStore;
    scope: string;
    index: string;
    values: string;
  } {
    const scope = `${prefix}:owned-action:{${createHash('sha256').update(userId).digest('hex')}}`;
    return {
      userId,
      store: new RedisOwnedOpaqueTokenStore(redis, prefix, { userId, productEpoch }),
      scope,
      index: `${scope}:${productEpoch}:index`,
      values: `${scope}:${productEpoch}:value:`,
    };
  }
  const token = (index: number): string => index.toString(16).padStart(16, '0');
  async function drain(store: RedisOwnedOpaqueTokenStore, limit = 100): Promise<number> {
    let cursor = '0',
      removed = 0;
    for (let batch = 0; batch < 2000; batch++) {
      const result = await store.revokeNext(limit, cursor);
      expect(result.removed).toBeLessThanOrEqual(limit);
      removed += result.removed;
      cursor = result.nextCursor;
      if (!result.hasMore) {
        expect(cursor).toBe('0');
        return removed;
      }
    }
    throw new Error('Opaque state revocation did not converge.');
  }

  it('isolates equal opaque references and stores no raw identity in physical keys', async () => {
    const first = subject(),
      second = subject();
    await expect(first.store.putIfAbsent(token(1), 'first private state', 30)).resolves.toBe(true);
    await expect(second.store.putIfAbsent(token(1), 'second private state', 30)).resolves.toBe(
      true,
    );
    expect(await first.store.get(token(1))).toBe('first private state');
    expect(await second.store.get(token(1))).toBe('second private state');
    const keys = await redis.keys(`${first.scope}:*`);
    expect(keys.every((key) => !key.includes(first.userId))).toBe(true);
    expect(await drain(first.store)).toBe(1);
    expect(await second.store.get(token(1))).toBe('second private state');
    await drain(second.store);
  });

  it('preserves the first allocation body and physical TTL on a replay', async () => {
    const owned = subject();
    await owned.store.putIfAbsent(token(1), 'first', 30);
    const [key] = await redis.keys(`${owned.values}*`);
    expect(await owned.store.putIfAbsent(token(1), 'replacement', 900)).toBe(false);
    expect(await redis.pttl(key!)).toBeLessThanOrEqual(30000);
    expect(await owned.store.get(token(1))).toBe('first');
    await drain(owned.store);
  });

  it('removes 205 live values in bounded batches before an independent full absence sweep', async () => {
    const owned = subject();
    await Promise.all(
      Array.from({ length: 205 }, (_, i) => owned.store.putIfAbsent(token(i), '{}', 30)),
    );
    expect(await owned.store.revokeNext()).toEqual({
      removed: 100,
      hasMore: true,
      nextCursor: '0',
    });
    expect(await owned.store.revokeNext()).toEqual({
      removed: 100,
      hasMore: true,
      nextCursor: '0',
    });
    expect(await drain(owned.store)).toBe(5);
    expect(await redis.keys(`${owned.values}*`)).toEqual([]);
    expect(await owned.store.isWriteRevoked()).toBe(true);
  });

  it('converges under twenty concurrent revokers and counts each removal once', async () => {
    const owned = subject();
    await Promise.all(
      Array.from({ length: 205 }, (_, i) => owned.store.putIfAbsent(token(i), '{}', 30)),
    );
    const batches = await Promise.all(Array.from({ length: 20 }, () => owned.store.revokeNext()));
    expect(
      batches.reduce((sum, batch) => sum + batch.removed, 0) + (await drain(owned.store)),
    ).toBe(205);
    expect(await drain(owned.store)).toBe(0);
  });

  it('fences racing writes and every late retry after revocation', async () => {
    const owned = subject();
    const results = await Promise.allSettled([
      ...Array.from({ length: 20 }, (_, i) => owned.store.putIfAbsent(token(i), '{}', 30)),
      owned.store.revokeNext(),
      ...Array.from({ length: 20 }, (_, i) => owned.store.putIfAbsent(token(i + 20), '{}', 30)),
    ]);
    expect(results[20]?.status).toBe('fulfilled');
    await drain(owned.store);
    await expect(owned.store.putIfAbsent(token(50), 'late private state', 30)).rejects.toThrow(
      /unavailable/,
    );
    expect(await owned.store.get(token(0))).toBeUndefined();
    expect(await redis.keys(`${owned.values}*`)).toEqual([]);
  });

  it('rejects a foreign reverse-index member before deleting either subject body', async () => {
    const owned = subject(),
      other = subject();
    await owned.store.putIfAbsent(token(1), 'owned', 30);
    await other.store.putIfAbsent(token(1), 'counterpart', 30);
    const [ownKey] = await redis.keys(`${owned.values}*`),
      [otherKey] = await redis.keys(`${other.values}*`);
    await redis.hset(owned.index, otherKey!, '1');
    await expect(owned.store.revokeNext()).rejects.toThrow(/unavailable/);
    expect(await redis.get(ownKey!)).toBe('owned');
    expect(await other.store.get(token(1))).toBe('counterpart');
    await redis.hdel(owned.index, otherKey!);
    await drain(owned.store);
    await drain(other.store);
  });

  it('finds and removes a physical orphan even after its index reference disappears', async () => {
    const owned = subject();
    await owned.store.putIfAbsent(token(1), 'orphan private state', 30);
    await redis.del(owned.index);
    expect(await drain(owned.store)).toBe(1);
    expect(await redis.keys(`${owned.values}*`)).toEqual([]);
  });

  it('caps actual deletion counts when SCAN returns more matches than the requested limit', async () => {
    const owned = subject();
    await Promise.all(
      Array.from({ length: 205 }, (_, i) => owned.store.putIfAbsent(token(i), '{}', 30)),
    );
    await redis.del(owned.index);
    expect(await drain(owned.store, 7)).toBe(205);
    expect(await redis.keys(`${owned.values}*`)).toEqual([]);
  });

  it('rejects unknown nonzero lives without initializing or revoking their authority', async () => {
    const owned = subject(randomUUID(), 1);
    await expect(owned.store.putIfAbsent(token(1), '{}', 30)).rejects.toThrow(/unavailable/);
    await expect(owned.store.revokeNext()).rejects.toThrow(/unavailable/);
    expect(await redis.get(`${owned.scope}:life`)).toBeNull();
    expect(await owned.store.get(token(1))).toBeUndefined();
  });

  it('denies old-life writers, readers and cleanup after a separately activated newer life', async () => {
    const owned = subject();
    await owned.store.putIfAbsent(token(1), '{}', 30);
    await drain(owned.store);
    // Privileged fixture only: production fresh-return authorization is separate.
    await redis.set(`${owned.scope}:life`, 'active:1');
    const returned = subject(owned.userId, 1);
    await returned.store.putIfAbsent(token(1), 'new life', 30);
    await expect(owned.store.putIfAbsent(token(2), '{}', 30)).rejects.toThrow(/unavailable/);
    await expect(owned.store.revokeNext()).rejects.toThrow(/unavailable/);
    expect(await owned.store.get(token(1))).toBeUndefined();
    expect(await returned.store.get(token(1))).toBe('new life');
    await drain(returned.store);
  });

  it('fails closed on a malformed index without exposing Redis diagnostics or allocating a body', async () => {
    const owned = subject();
    await redis.set(owned.index, 'private corrupt index');
    await expect(owned.store.putIfAbsent(token(1), '{}', 30)).rejects.toThrow(
      'Opaque state operation is unavailable.',
    );
    expect(await redis.keys(`${owned.values}*`)).toEqual([]);
    await redis.del(owned.index);
    await drain(owned.store);
  });

  it('removes expired references and requires the full sweep even with no live bodies', async () => {
    const owned = subject();
    await owned.store.putIfAbsent(token(1), '{}', 30);
    const [key] = await redis.keys(`${owned.values}*`);
    await redis.del(key!);
    expect(await owned.store.revokeNext()).toEqual({ removed: 0, hasMore: true, nextCursor: '0' });
    expect(await drain(owned.store)).toBe(0);
    await expect(owned.store.revokeNext(101)).rejects.toThrow(/invalid/);
    await expect(owned.store.revokeNext(1, '-1')).rejects.toThrow(/invalid/);
  });

  it('binds real Liked By signatures to owner and life even when logical identities are reused', async () => {
    const userId = randomUUID(),
      otherId = randomUUID(),
      likeId = randomUUID(),
      requestId = randomUUID();
    const old = subject(userId, 0),
      next = subject(userId, 1),
      other = subject(otherId, 0);
    const key = new Uint8Array(32).fill(17);
    const oldReferences = LikedByOpaqueReferences.forLife(old.store, key, {
      userId,
      productEpoch: 0,
    });
    const oldToken = await oldReferences.issueAction(userId, likeId, requestId);
    expect(await oldReferences.resolveAction(oldToken, userId)).toBe(likeId);
    const otherReferences = LikedByOpaqueReferences.forLife(other.store, key, {
      userId: otherId,
      productEpoch: 0,
    });
    expect(await otherReferences.resolveAction(oldToken, otherId)).toBeUndefined();
    await drain(old.store);
    // Privileged Redis fixture only; approved native Return activation is separate.
    await redis.set(`${old.scope}:life`, 'active:1');
    const nextReferences = LikedByOpaqueReferences.forLife(next.store, key, {
      userId,
      productEpoch: 1,
    });
    const nextToken = await nextReferences.issueAction(userId, likeId, requestId);
    expect(nextToken).not.toBe(oldToken);
    expect(await nextReferences.resolveAction(oldToken, userId)).toBeUndefined();
    expect(await nextReferences.resolveAction(nextToken, userId)).toBe(likeId);
    expect(await oldReferences.resolveAction(nextToken, userId)).toBeUndefined();
    await drain(next.store);
    await drain(other.store);
  });

  it('rejects delayed twenty-way old-life issuance after revocation without touching a new life', async () => {
    const old = subject(),
      next = subject(old.userId, 1),
      key = new Uint8Array(32).fill(18);
    const frozen = LikedByOpaqueReferences.forLife(old.store, key, {
      userId: old.userId,
      productEpoch: 0,
    });
    await drain(old.store);
    await redis.set(`${old.scope}:life`, 'active:1');
    const current = LikedByOpaqueReferences.forLife(next.store, key, {
      userId: old.userId,
      productEpoch: 1,
    });
    const likeId = randomUUID(),
      requestId = randomUUID();
    const token = await current.issueAction(old.userId, likeId, requestId);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () => frozen.issueAction(old.userId, likeId, requestId)),
    );
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(await redis.keys(`${old.values}*`)).toEqual([]);
    expect(await current.resolveAction(token, old.userId)).toBe(likeId);
    await drain(next.store);
  });
});
