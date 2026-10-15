import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createRedisConnection,
  RedisOwnedOpaqueTokenStore,
  RedisAccountReturnActivation,
} from './index.js';
import { LikedByOpaqueReferences, type AccountReturnActivationAuthority } from '@nakh/application';

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
  // Script-boundary fixture only. Actual native approval/Return/namespace
  // authorization is exercised with the real worker in its composition suite.
  function activation(): RedisAccountReturnActivation {
    const authority: AccountReturnActivationAuthority = {
      withCurrentReturn: async (life, _hash, effect) =>
        effect({
          ...life,
          previousProductEpoch: life.productEpoch - 1,
          returnAuditId: randomUUID(),
        }),
    };
    return new RedisAccountReturnActivation(redis, prefix, authority);
  }
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
  it('activates exactly the predecessor under twenty retries and refuses all delayed old-life allocations', async () => {
    const old = subject(),
      current = subject(old.userId, 1),
      activate = activation();
    await old.store.putIfAbsent(token(1), 'old private', 900);
    await drain(old.store);
    await Promise.all(
      Array.from({ length: 20 }, () => activate.activate({ userId: old.userId, productEpoch: 1 })),
    );
    await current.store.putIfAbsent(token(1), 'fresh private', 900);
    const rejected = await Promise.allSettled(
      Array.from({ length: 20 }, () => old.store.putIfAbsent(token(2), 'late old private', 900)),
    );
    expect(rejected.every((r) => r.status === 'rejected')).toBe(true);
    await expect(old.store.revokeNext()).rejects.toThrow('unavailable');
    expect(await current.store.get(token(1))).toBe('fresh private');
    expect(await old.store.get(token(1))).toBeUndefined();
    expect(await redis.get(`${old.scope}:life`)).toBe('active:1');
    expect(await redis.pttl(`${old.scope}:life`)).toBe(-1);
    expect(await redis.keys(`${old.values}*`)).toEqual([]);
    await drain(current.store);
  });
  it('rejects missing, malformed, expiring, initial-active and later markers without changing them', async () => {
    const old = subject(),
      activate = activation(),
      life = { userId: old.userId, productEpoch: 1 },
      marker = `${old.scope}:life`;
    await expect(activate.activate(life)).rejects.toThrow('unavailable');
    expect(await redis.get(marker)).toBeNull();
    for (const value of ['active:0', 'blocked:00', 'blocked:2', 'active:2', 'private marker']) {
      await redis.set(marker, value);
      await expect(activate.activate(life)).rejects.toThrow('unavailable');
      expect(await redis.get(marker)).toBe(value);
    }
    await redis.set(marker, 'blocked:0', 'PX', 5000);
    await expect(activate.activate(life)).rejects.toThrow('unavailable');
    expect(await redis.get(marker)).toBe('blocked:0');
    expect(await redis.pttl(marker)).toBeGreaterThan(0);
    await redis.set(marker, 'blocked:0');
  });
  it('requires the old reverse index to be empty and never copies an old body', async () => {
    const old = subject(),
      activate = activation();
    await old.store.putIfAbsent(token(1), 'old one', 900);
    await old.store.putIfAbsent(token(2), 'old two', 900);
    await old.store.revokeNext(1);
    expect(await redis.hlen(old.index)).toBe(1);
    await expect(activate.activate({ userId: old.userId, productEpoch: 1 })).rejects.toThrow(
      'unavailable',
    );
    expect(await redis.get(`${old.scope}:life`)).toBe('blocked:0');
    await drain(old.store);
    await activate.activate({ userId: old.userId, productEpoch: 1 });
    expect(await redis.keys(`${old.values}*`)).toEqual([]);
    expect(await redis.keys(`${old.scope}:1:value:*`)).toEqual([]);
    await drain(subject(old.userId, 1).store);
  });
  it('rejects a preexisting new-life index and leaves foreign data untouched', async () => {
    const old = subject(),
      next = subject(old.userId, 1),
      other = subject();
    await drain(old.store);
    await other.store.putIfAbsent(token(1), 'foreign private', 900);
    const [foreign] = await redis.keys(`${other.values}*`);
    await redis.hset(next.index, foreign!, '1');
    await expect(activation().activate({ userId: old.userId, productEpoch: 1 })).rejects.toThrow(
      'unavailable',
    );
    expect(await redis.get(`${old.scope}:life`)).toBe('blocked:0');
    expect(await other.store.get(token(1))).toBe('foreign private');
    await redis.del(next.index);
    await drain(other.store);
  });
  it('lets a native owning cleanup fence a returned life before activation and never reopens that tombstone', async () => {
    const old = subject(),
      one = subject(old.userId, 1),
      two = subject(old.userId, 2),
      activate = activation();
    await drain(old.store);
    expect(await drain(one.store)).toBe(0);
    expect(await redis.get(`${old.scope}:life`)).toBe('blocked:1');
    await expect(activate.activate({ userId: old.userId, productEpoch: 1 })).rejects.toThrow(
      'unavailable',
    );
    await activate.activate({ userId: old.userId, productEpoch: 2 });
    await two.store.putIfAbsent(token(1), 'life two', 900);
    await expect(activate.activate({ userId: old.userId, productEpoch: 1 })).rejects.toThrow(
      'unavailable',
    );
    await expect(one.store.revokeNext()).rejects.toThrow('unavailable');
    expect(await redis.get(`${old.scope}:life`)).toBe('active:2');
    expect(await two.store.get(token(1))).toBe('life two');
    await drain(two.store);
  });
  it('recovers from a lost activation acknowledgment without replacing new-life state or extending its TTL', async () => {
    const old = subject(),
      next = subject(old.userId, 1);
    await drain(old.store);
    const authority: AccountReturnActivationAuthority = {
      withCurrentReturn: async (life, _hash, effect) =>
        effect({ ...life, previousProductEpoch: 0, returnAuditId: randomUUID() }),
    };
    const failed = new RedisAccountReturnActivation(
      {
        eval: async (script, count, ...args) => {
          await redis.eval(script, count, ...args);
          throw new Error('private transport failure');
        },
      },
      prefix,
      authority,
    );
    await expect(failed.activate({ userId: old.userId, productEpoch: 1 })).rejects.toThrow(
      'Opaque state activation is unavailable.',
    );
    await next.store.putIfAbsent(token(1), 'new private', 900);
    const [key] = await redis.keys(`${next.values}*`),
      ttl = await redis.pttl(key!);
    await activation().activate({ userId: old.userId, productEpoch: 1 });
    expect(await next.store.get(token(1))).toBe('new private');
    expect(await redis.pttl(key!)).toBeLessThanOrEqual(ttl);
    await drain(next.store);
  });
  it('rejects non-native epoch ranges before issuing any Redis operation', () => {
    for (const productEpoch of [-1, 2147483648, NaN, Infinity])
      expect(
        () => new RedisOwnedOpaqueTokenStore(redis, prefix, { userId: randomUUID(), productEpoch }),
      ).toThrow('Opaque state life is invalid.');
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
