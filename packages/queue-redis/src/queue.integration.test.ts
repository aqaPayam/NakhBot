import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import type { DomainEvent } from '@nakh/contracts';

import {
  BullMqOutboxPublisher,
  createDomainEventWorker,
  createRedisConnection,
  RedisLease,
  RedisRateLimiter,
} from './index.js';

const redisUrl = process.env['NAKH_TEST_REDIS_URL'];

describe.skipIf(redisUrl === undefined)('Redis queue reliability', () => {
  const prefix = `nakh-integration-${randomUUID()}`;
  const publisherConnection = createRedisConnection(redisUrl ?? 'redis://invalid');
  const workerConnection = createRedisConnection(redisUrl ?? 'redis://invalid');
  const leaseConnection = createRedisConnection(redisUrl ?? 'redis://invalid');
  const publisher = new BullMqOutboxPublisher(publisherConnection, prefix);

  afterAll(async () => {
    await publisher.close();
    await Promise.all([
      publisherConnection.quit(),
      workerConnection.quit(),
      leaseConnection.quit(),
    ]);
  });

  it('deduplicates a replayed event by its stable job id', async () => {
    const event: DomainEvent = {
      id: randomUUID(),
      eventType: 'platform.sample-effect-created',
      schemaVersion: 1,
      aggregateType: 'sample-effect',
      aggregateId: randomUUID(),
      payload: { name: 'replay-safe' },
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    };
    let deliveries = 0;
    let completeDelivery: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => {
      completeDelivery = resolve;
    });
    const worker = createDomainEventWorker(workerConnection, prefix, () => {
      deliveries += 1;
      completeDelivery?.();
      return Promise.resolve();
    });

    try {
      await publisher.publish(event);
      await publisher.publish(event);
      await delivered;
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(deliveries).toBe(1);
    } finally {
      await worker.close();
    }
  });

  it('only lets the lease owner release a lease', async () => {
    const lease = new RedisLease(leaseConnection);
    const key = `${prefix}:scheduler-lease`;

    await expect(lease.acquire(key, 'owner-a', 5_000)).resolves.toBe(true);
    await expect(lease.acquire(key, 'owner-b', 5_000)).resolves.toBe(false);
    await expect(lease.release(key, 'owner-b')).resolves.toBe(false);
    await expect(lease.release(key, 'owner-a')).resolves.toBe(true);
    await expect(lease.acquire(key, 'owner-b', 5_000)).resolves.toBe(true);
    await expect(lease.release(key, 'owner-b')).resolves.toBe(true);
  });

  it('enforces a shared atomic rate limit without storing the raw subject', async () => {
    const limiter = new RedisRateLimiter(leaseConnection, prefix);
    const decisions = await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.consume({
          scope: 'telegram_start',
          subject: 'private-telegram-id',
          limit: 3,
          windowSeconds: 60,
        }),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(3);
    const keys = await leaseConnection.keys(`${prefix}:rate:telegram_start:*`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('private-telegram-id');
  });
});
