import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisConnection, RedisOwnedOpaqueTokenStore } from '@nakh/queue-redis';
import { TelegramPhotoActionTokens, type TelegramPhotoActionTokenState } from '@nakh/telegram';

const url = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined)('M8 actual Redis photo action life', () => {
  const redis = createRedisConnection(url ?? 'redis://invalid');
  const prefix = `m8-photo-${randomUUID()}`,
    key = new Uint8Array(32).fill(29);
  afterAll(async () => {
    await redis.quit();
  });
  function subject(
    userId: string = randomUUID(),
    productEpoch = 0,
  ): Readonly<{
    life: Readonly<{ userId: string; productEpoch: number }>;
    scope: string;
    store: RedisOwnedOpaqueTokenStore;
    tokens: TelegramPhotoActionTokens;
    values: string;
  }> {
    const life = { userId, productEpoch };
    const scope = `${prefix}:owned-action:{${createHash('sha256').update(userId).digest('hex')}}`;
    const store = new RedisOwnedOpaqueTokenStore(redis, prefix, life);
    return {
      life,
      scope,
      store,
      tokens: TelegramPhotoActionTokens.forLife(store, key, life),
      values: `${scope}:${productEpoch}:value:`,
    };
  }
  async function drain(store: RedisOwnedOpaqueTokenStore): Promise<void> {
    let cursor = '0';
    for (let batch = 0; batch < 2000; batch++) {
      const result = await store.revokeNext(100, cursor);
      expect(result.removed).toBeLessThanOrEqual(100);
      if (!result.hasMore) return;
      cursor = result.nextCursor;
    }
    throw new Error('Photo token sweep did not complete.');
  }
  const state = (): TelegramPhotoActionTokenState => ({
    telegramUserId: '123456789',
    expectedProfileVersion: 1,
    action: { type: 'select_primary' as const, photoId: randomUUID() },
  });
  it('rejects old signatures even when an identical logical reference is copied into a newer life', async () => {
    const old = subject(),
      next = subject(old.life.userId, 1),
      other = subject();
    const value = state(),
      oldToken = await old.tokens.issue(value);
    expect(await old.tokens.resolve(oldToken, value.telegramUserId)).toEqual(value);
    expect(await other.tokens.resolve(oldToken, value.telegramUserId)).toBeUndefined();
    const id = oldToken.split('.')[2]!,
      body = await old.store.get(id);
    expect(body).toBeDefined();
    await drain(old.store);
    // Privileged Redis fixture only; no approved native Return is claimed.
    await redis.set(`${old.scope}:life`, 'active:1');
    expect(await next.store.putIfAbsent(id, body!, 900)).toBe(true);
    expect(await next.tokens.resolve(oldToken, value.telegramUserId)).toBeUndefined();
    const nextToken = await next.tokens.issue(value);
    expect(await next.tokens.resolve(nextToken, value.telegramUserId)).toEqual(value);
    expect(await old.tokens.resolve(nextToken, value.telegramUserId)).toBeUndefined();
    await drain(next.store);
    await drain(other.store);
  });
  it('denies twenty delayed old-life issuers without changing a new-life menu action', async () => {
    const old = subject(),
      next = subject(old.life.userId, 1),
      value = state();
    await old.tokens.issue(value);
    await drain(old.store);
    await redis.set(`${old.scope}:life`, 'active:1');
    const token = await next.tokens.issue(value);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () => old.tokens.issue(value)),
    );
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(await redis.keys(`${old.values}*`)).toEqual([]);
    expect(await next.tokens.resolve(token, value.telegramUserId)).toEqual(value);
    await drain(next.store);
  });
});
