import { describe, expect, it } from 'vitest';

import { createRedisConnection, DOMAIN_EVENT_QUEUE, RedisOpaqueTokenStore } from './index.js';

describe('queue contracts', () => {
  it('uses a stable queue name', () => {
    expect(DOMAIN_EVENT_QUEUE).toBe('domain-events');
  });

  it('rejects unowned namespaces, byte overflow and extended grants before opening a Redis connection', async () => {
    const redis = createRedisConnection('redis://127.0.0.1:1');
    const tokens = new RedisOpaqueTokenStore(redis, 'm8-rejection-only');
    const reference = 'a'.repeat(22);
    try {
      for (const [id, value, ttl] of [
        [`unowned:${reference}`, '{}', 300],
        [`telegram-report:${reference}\n`, '{}', 30],
        [`telegram-admin-queue:unowned:${reference}`, '{}', 300],
        ['a'.repeat(16), 'پ'.repeat(2049), 30],
        ['a'.repeat(16), '{}', 86401],
        [`telegram-admin-safety-read:${reference}`, '{}', 301],
        [`telegram-admin-support-mutation:${reference}`, 'a'.repeat(32769), 300],
      ] as const)
        await expect(tokens.putIfAbsent(id, value, ttl)).rejects.toThrow(/Opaque token/);
      await expect(tokens.get('unowned')).resolves.toBeUndefined();
      expect(redis.status).toBe('wait');
    } finally {
      redis.disconnect();
    }
  });
});
