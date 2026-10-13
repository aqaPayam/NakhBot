import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@nakh/contracts';
import {
  BullMqLegacyReferenceMigration,
  createRedisConnection,
  DOMAIN_EVENT_QUEUE,
  type QueueReferenceMigrationAudit,
  type QueueReferenceMigrationCursor,
} from './index.js';

const url = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined)('M8 atomic audited legacy queue migration', () => {
  const redis = createRedisConnection(url ?? 'redis://invalid');
  afterAll(async () => {
    await redis.quit();
  });
  function scene(overrides: Partial<QueueReferenceMigrationAudit> = {}): {
    prefix: string;
    migrator: BullMqLegacyReferenceMigration;
    outcomes: string[];
    prepared: string[];
  } {
    const prefix = `m8-legacy-${randomUUID()}`,
      outcomes: string[] = [],
      prepared: string[] = [];
    const audit: QueueReferenceMigrationAudit = {
      prepare: (_queueHash, reference) => {
        prepared.push(reference.eventId);
        return Promise.resolve(randomUUID());
      },
      observe: (_id, outcome) => {
        outcomes.push(outcome);
        return Promise.resolve();
      },
      reconcile: () => Promise.resolve(),
      ...overrides,
    };
    return {
      prefix,
      migrator: new BullMqLegacyReferenceMigration(redis, prefix, audit),
      outcomes,
      prepared,
    };
  }
  async function seed(prefix: string): Promise<{ key: string; event: DomainEvent; raw: string }> {
    const event: DomainEvent = {
      id: randomUUID(),
      eventType: 'platform.sample-effect-created.v1',
      schemaVersion: 1,
      aggregateType: 'sample_effect',
      aggregateId: randomUUID(),
      payload: {},
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    };
    event.payload.effectId = event.aggregateId;
    event.payload.name = 'private legacy clone';
    const key = `${prefix}:${DOMAIN_EVENT_QUEUE}:${event.id}`,
      raw = JSON.stringify(event);
    await redis.hset(key, { name: event.eventType, data: raw });
    return { key, event, raw };
  }
  function cursor(keys: readonly string[]): QueueReferenceMigrationCursor {
    return { redisCursor: '0', pendingKeys: keys };
  }
  async function sweep(migrator: BullMqLegacyReferenceMigration, limit = 100): Promise<number> {
    let next: QueueReferenceMigrationCursor = { redisCursor: '0', pendingKeys: [] },
      normalized = 0;
    for (let i = 0; i < 2000; i++) {
      const result = await migrator.scanNext(next, limit);
      expect(result.normalized).toBeLessThanOrEqual(limit);
      normalized += result.normalized;
      next = result.nextCursor;
      if (!result.hasMore) return normalized;
    }
    throw new Error('queue_migration_did_not_converge');
  }

  it('normalizes a validated legacy body only after audit authorization and records the outcome', async () => {
    const context = scene(),
      sample = await seed(context.prefix);
    expect((await context.migrator.scanNext(cursor([sample.key]))).normalized).toBe(1);
    const data: unknown = JSON.parse((await redis.hget(sample.key, 'data'))!);
    expect(data).toMatchObject({ kind: 'outbox-reference.v1', eventId: sample.event.id });
    expect(JSON.stringify(data)).not.toContain('private legacy clone');
    expect(context.outcomes).toEqual(['normalized']);
  });
  it('preserves the exact original bytes when audit preparation is unavailable', async () => {
    const context = scene({ prepare: () => Promise.reject(new Error('audit_unavailable')) }),
      sample = await seed(context.prefix);
    await expect(context.migrator.scanNext(cursor([sample.key]))).rejects.toThrow(
      'audit_unavailable',
    );
    expect(await redis.hget(sample.key, 'data')).toBe(sample.raw);
  });
  it('skips an already-active job without preparing or overwriting its body', async () => {
    const context = scene(),
      sample = await seed(context.prefix);
    await redis.set(`${sample.key}:lock`, 'worker');
    const result = await context.migrator.scanNext(cursor([sample.key]));
    expect(result.active).toBe(1);
    expect(result.hasMore).toBe(true);
    expect(context.prepared).toEqual([]);
    expect(await redis.hget(sample.key, 'data')).toBe(sample.raw);
    await redis.del(`${sample.key}:lock`);
    expect(await sweep(context.migrator)).toBe(1);
  });
  it('atomically skips a lock acquired during native authorization', async () => {
    let key = '';
    const context = scene({
      prepare: async () => {
        await redis.set(`${key}:lock`, 'new-worker');
        return randomUUID();
      },
    });
    const sample = await seed(context.prefix);
    key = sample.key;
    const result = await context.migrator.scanNext(cursor([key]));
    expect(result.active).toBe(1);
    expect(context.outcomes).toEqual(['active']);
    expect(await redis.hget(key, 'data')).toBe(sample.raw);
  });
  it('refuses to overwrite a body changed during authorization', async () => {
    let key = '',
      altered = '';
    const context = scene({
      prepare: async () => {
        await redis.hset(key, 'data', altered);
        return randomUUID();
      },
    });
    const sample = await seed(context.prefix);
    key = sample.key;
    altered = JSON.stringify({
      ...sample.event,
      payload: { ...sample.event.payload, name: 'private changed body' },
    });
    const result = await context.migrator.scanNext(cursor([key]));
    expect(result.changed).toBe(1);
    expect(context.outcomes).toEqual(['changed']);
    expect(await redis.hget(key, 'data')).toBe(altered);
  });
  it('treats concurrent removal as gone without fabricating normalized work', async () => {
    let key = '';
    const context = scene({
      prepare: async () => {
        await redis.del(key);
        return randomUUID();
      },
    });
    const sample = await seed(context.prefix);
    key = sample.key;
    expect((await context.migrator.scanNext(cursor([key]))).normalized).toBe(0);
    expect(context.outcomes).toEqual(['gone']);
  });
  it('counts one conversion under twenty concurrent scanner attempts', async () => {
    const context = scene(),
      sample = await seed(context.prefix);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => context.migrator.scanNext(cursor([sample.key]))),
    );
    expect(results.reduce((sum, result) => sum + result.normalized, 0)).toBe(1);
  });
  it('persists oversized-page metadata and converges at a seven-job limit without losing remaining keys', async () => {
    const context = scene();
    await Promise.all(Array.from({ length: 205 }, () => seed(context.prefix)));
    expect(await sweep(context.migrator, 7)).toBe(205);
    expect(await sweep(context.migrator, 7)).toBe(0);
  });
  it('resumes reconciliation after a post-conversion observation failure', async () => {
    let reconciled = 0;
    const context = scene({
      observe: () => Promise.reject(new Error('observation_unavailable')),
      reconcile: () => {
        reconciled++;
        return Promise.resolve();
      },
    });
    const sample = await seed(context.prefix);
    await expect(context.migrator.scanNext(cursor([sample.key]))).rejects.toThrow(
      'observation_unavailable',
    );
    expect(await redis.hget(sample.key, 'data')).not.toContain('private legacy clone');
    await context.migrator.scanNext(cursor([sample.key]));
    expect(reconciled).toBe(1);
  });
  it('rejects a forged reference with private extra fields instead of blessing it as already migrated', async () => {
    const context = scene(),
      sample = await seed(context.prefix);
    await redis.hset(
      sample.key,
      'data',
      JSON.stringify({
        kind: 'outbox-reference.v1',
        eventId: sample.event.id,
        eventType: sample.event.eventType,
        eventSchemaVersion: 1,
        aggregateType: sample.event.aggregateType,
        aggregateId: sample.event.aggregateId,
        payload: { name: 'private concealed clone' },
      }),
    );
    await expect(context.migrator.scanNext(cursor([sample.key]))).rejects.toThrow(
      'invalid_queue_migration_source',
    );
  });
  it('rejects foreign pending keys before touching another namespace', async () => {
    const context = scene(),
      other = await seed(`other-${randomUUID()}`);
    await expect(context.migrator.scanNext(cursor([other.key]))).rejects.toThrow(
      'invalid_queue_migration_batch',
    );
    expect(await redis.hget(other.key, 'data')).toBe(other.raw);
  });
  it('keeps canonical reference and non-job metadata unchanged on an empty migration pass', async () => {
    const context = scene(),
      sample = await seed(context.prefix);
    await context.migrator.scanNext(cursor([sample.key]));
    const migrated = await redis.hget(sample.key, 'data');
    await redis.hset(`${context.prefix}:${DOMAIN_EVENT_QUEUE}:meta`, { pause: 1 });
    expect(await sweep(context.migrator)).toBe(0);
    expect(await redis.hget(sample.key, 'data')).toBe(migrated);
  });
});
