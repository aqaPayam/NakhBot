import { describe, expect, it } from 'vitest';

import {
  createRedisConnection,
  DOMAIN_EVENT_QUEUE,
  RedisOpaqueTokenStore,
  RedisLegacyOpaqueStateRetirement,
} from './index.js';
import { randomUUID } from 'node:crypto';

describe('queue contracts', () => {
  it('rejects unsafe retirement namespaces and scan bounds before opening a connection or authorizing removal', async () => {
    const redis = createRedisConnection('redis://127.0.0.1:1');
    let authorizations = 0;
    const audit = {
      prepare: () => {
        authorizations++;
        return Promise.resolve(randomUUID());
      },
      observe: () => Promise.resolve(),
    };
    try {
      for (const prefix of [
        '',
        'bad*namespace',
        'bad?namespace',
        'bad[namespace',
        'private\nnamespace',
        'a'.repeat(129),
      ])
        expect(() => new RedisLegacyOpaqueStateRetirement(redis, prefix, audit)).toThrow(
          /unavailable/,
        );
      const retirement = new RedisLegacyOpaqueStateRetirement(redis, 'valid-namespace', audit);
      for (const cursor of [
        '-1',
        '01',
        'untrusted',
        '0\n',
        '1'.repeat(21),
        '18446744073709551616',
      ]) {
        await expect(retirement.revokeNext(cursor)).rejects.toThrow(/unavailable/);
        await expect(retirement.verifyNext(cursor)).rejects.toThrow(/unavailable/);
      }
      for (const limit of [0, 101, 1.5, NaN])
        await expect(retirement.revokeNext('0', limit)).rejects.toThrow(/unavailable/);
      expect(authorizations).toBe(0);
      expect(redis.status).toBe('wait');
    } finally {
      redis.disconnect();
    }
  });
  it('rejects malformed audit authority before touching legacy storage', async () => {
    const redis = createRedisConnection('redis://127.0.0.1:1');
    let observations = 0;
    const audit = {
      prepare: () => Promise.resolve('not-native-authority'),
      observe: () => {
        observations++;
        return Promise.resolve();
      },
    };
    try {
      await expect(
        new RedisLegacyOpaqueStateRetirement(redis, 'valid-namespace', audit).revokeNext(),
      ).rejects.toThrow(/unavailable/);
      expect(redis.status).toBe('wait');
      expect(observations).toBe(0);
    } finally {
      redis.disconnect();
    }
  });
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
