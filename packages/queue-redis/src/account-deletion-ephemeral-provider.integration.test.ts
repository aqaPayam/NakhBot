import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@nakh/contracts';
import type {
  DeletionEphemeralOperation,
  DeletionEphemeralStage,
  DeletionEphemeralCursor,
  LegacyOpaqueRetirementAudit,
} from '@nakh/application';
import {
  createRedisConnection,
  RedisOwnedOpaqueTokenStore,
  RedisAccountDeletionEphemeralProvider,
  BullMqOutboxPublisher,
  createDomainEventWorker,
  type QueueReferenceMigrationAudit,
  type QueuedEventReference,
} from './index.js';
const url = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined)('M8 independent physical ephemeral provider passes', () => {
  const redis = createRedisConnection(url ?? 'redis://invalid');
  afterAll(async () => {
    await redis.quit();
  });
  function scene(): {
    prefix: string;
    provider: RedisAccountDeletionEphemeralProvider;
    op: (
      stage: DeletionEphemeralStage,
      cursor?: DeletionEphemeralCursor,
    ) => DeletionEphemeralOperation;
    guard: () => Promise<void>;
  } {
    const prefix = `m8-pass-${randomUUID()}`,
      userId = randomUUID();
    const legacy: LegacyOpaqueRetirementAudit = {
      prepare: () => Promise.resolve(randomUUID()),
      observe: () => Promise.resolve(),
    };
    const queue: QueueReferenceMigrationAudit & {
      verifyReference(reference: QueuedEventReference): Promise<void>;
    } = {
      verifyReference: () => Promise.resolve(),
      prepare: () => Promise.resolve(randomUUID()),
      observe: () => Promise.resolve(),
      reconcile: () => Promise.resolve(),
    };
    const provider = new RedisAccountDeletionEphemeralProvider(redis, prefix, legacy, queue);
    return {
      prefix,
      provider,
      guard: () => Promise.resolve(),
      op: (stage, cursor) => ({
        id: randomUUID(),
        deletionRecordId: randomUUID(),
        userId,
        productEpoch: 0,
        namespaceHash: provider.namespaceHash,
        cutoverEvidenceHash: 'a'.repeat(64),
        stage,
        cursor:
          cursor ?? (stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0'),
      }),
    };
  }
  async function pass(f: ReturnType<typeof scene>, stage: DeletionEphemeralStage): Promise<number> {
    let cursor: DeletionEphemeralCursor = stage.startsWith('queue_')
        ? { redisCursor: '0', pendingKeys: [] }
        : '0',
      found = 0;
    for (let n = 0; n < 2000; n++) {
      const result = await f.provider.execute(f.op(stage, cursor), f.guard);
      found += result.found;
      cursor = result.cursor;
      if (!result.more) return found;
    }
    throw new Error('Provider pass did not converge.');
  }
  async function job(prefix: string): Promise<{ key: string; event: DomainEvent }> {
    const id = randomUUID(),
      event: DomainEvent = {
        id,
        eventType: 'platform.sample-effect-created.v1',
        schemaVersion: 1,
        aggregateType: 'sample_effect',
        aggregateId: randomUUID(),
        payload: { name: 'PRIVATE TRANSPORT BODY' },
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        causationId: randomUUID(),
      };
    const key = `${prefix}:domain-events:${id}`;
    await redis.hset(key, {
      name: event.eventType,
      data: JSON.stringify(event),
      failedReason: 'PRIVATE FAILURE',
      stacktrace: JSON.stringify(['PRIVATE TRACE']),
      returnvalue: JSON.stringify({ secret: 'PRIVATE RESULT' }),
      progress: JSON.stringify({ secret: 'PRIVATE PROGRESS' }),
    });
    return { key, event };
  }
  it('independently finds unindexed bodies, preserves a counterpart and requires a permanent fence', async () => {
    const f = scene(),
      op = f.op('owned_remove'),
      owned = new RedisOwnedOpaqueTokenStore(redis, f.prefix, op),
      other = new RedisOwnedOpaqueTokenStore(redis, f.prefix, {
        userId: randomUUID(),
        productEpoch: 0,
      });
    await owned.putIfAbsent('abcdefghijklmnop', 'PRIVATE OWNED', 900);
    await other.putIfAbsent('abcdefghijklmnop', 'COUNTERPART', 900);
    expect(await pass(f, 'owned_verify')).toBeGreaterThan(0);
    await pass(f, 'owned_remove');
    expect(await pass(f, 'owned_verify')).toBe(0);
    const scope = `${f.prefix}:owned-action:{${createHash('sha256').update(op.userId).digest('hex')}}`;
    await redis.set(`${scope}:0:value:orphan`, 'PRIVATE ORPHAN');
    expect(await pass(f, 'owned_verify')).toBeGreaterThan(0);
    await pass(f, 'owned_remove');
    expect(await pass(f, 'owned_verify')).toBe(0);
    expect(await other.get('abcdefghijklmnop')).toBe('COUNTERPART');
    await redis.expire(`${scope}:life`, 30);
    expect(await pass(f, 'owned_verify')).toBeGreaterThan(0);
  });
  it('normalizes jobs and clears diagnostic/log/event clones in bounded passes before independent verification', async () => {
    const f = scene(),
      item = await job(f.prefix);
    await redis.rpush(`${item.key}:logs`, 'PRIVATE LOG');
    for (let n = 0; n < 205; n++)
      await redis.xadd(
        `${f.prefix}:domain-events:events`,
        '*',
        'event',
        'failed',
        'jobId',
        item.event.id,
        'failedReason',
        'PRIVATE EVENT',
      );
    expect(await pass(f, 'queue_normalize')).toBeGreaterThanOrEqual(0);
    expect(await pass(f, 'queue_verify')).toBe(0);
    const row = await redis.hgetall(item.key);
    expect(JSON.parse(row.data!)).toMatchObject({
      kind: 'outbox-reference.v1',
      eventId: item.event.id,
    });
    expect(JSON.stringify(row)).not.toContain('PRIVATE');
    expect(await redis.exists(`${item.key}:logs`)).toBe(0);
    expect(await redis.xlen(`${f.prefix}:domain-events:events`)).toBe(0);
  });
  it('blocks an active legacy job without changing its body and succeeds only after the lock ends', async () => {
    const f = scene(),
      item = await job(f.prefix),
      before = await redis.hget(item.key, 'data');
    await redis.set(`${item.key}:lock`, 'worker-token');
    expect(await pass(f, 'queue_normalize')).toBeGreaterThan(0);
    expect(await redis.hget(item.key, 'data')).toBe(before);
    expect(await pass(f, 'queue_verify')).toBeGreaterThan(0);
    await redis.del(`${item.key}:lock`);
    await pass(f, 'queue_normalize');
    expect(await pass(f, 'queue_verify')).toBe(0);
  });
  it('finds unsafe event content added after the cutover marker and preserves current content-free events', async () => {
    const f = scene();
    await pass(f, 'queue_normalize');
    const id = randomUUID();
    await redis.xadd(
      `${f.prefix}:domain-events:events`,
      '*',
      'event',
      'failed',
      'jobId',
      id,
      'failedReason',
      'PRIVATE LATE BODY',
    );
    expect(await pass(f, 'queue_verify')).toBeGreaterThan(0);
    await pass(f, 'queue_normalize');
    expect(await pass(f, 'queue_verify')).toBe(0);
    await redis.xadd(
      `${f.prefix}:domain-events:events`,
      '*',
      'event',
      'failed',
      'jobId',
      id,
      'failedReason',
      'domain_event_processing_failed',
    );
    expect(await pass(f, 'queue_verify')).toBe(0);
    expect(await redis.xlen(`${f.prefix}:domain-events:events`)).toBe(1);
  });
  it('rejects foreign cursors and unknown queue families without deleting their values', async () => {
    const f = scene(),
      key = `foreign:domain-events:${randomUUID()}`;
    await redis.hset(key, { data: 'PRIVATE FOREIGN' });
    await expect(
      f.provider.execute(
        f.op('queue_normalize', { redisCursor: '0', pendingKeys: [key] }),
        f.guard,
      ),
    ).rejects.toBeDefined();
    expect(await redis.hget(key, 'data')).toBe('PRIVATE FOREIGN');
    const unknown = `${f.prefix}:domain-events:unknown-body`;
    await redis.set(unknown, 'PRIVATE UNKNOWN');
    await expect(pass(f, 'queue_normalize')).rejects.toBeDefined();
    expect(await redis.get(unknown)).toBe('PRIVATE UNKNOWN');
  });
  it('rejects an expiring queue fence and propagates lost native authority before any provider mutation', async () => {
    const f = scene();
    await pass(f, 'queue_normalize');
    await redis.expire(`${f.prefix}:m8-queue-event-cutover`, 30);
    expect(await pass(f, 'queue_verify')).toBeGreaterThan(0);
    await pass(f, 'queue_normalize');
    expect(await pass(f, 'queue_verify')).toBe(0);
    const next = scene(),
      item = await job(next.prefix);
    await expect(
      next.provider.execute(next.op('queue_normalize'), () =>
        Promise.reject(new Error('lease ended')),
      ),
    ).rejects.toThrow('lease ended');
    expect(await redis.hget(item.key, 'data')).toBe(JSON.stringify(item.event));
  });
  it('persists only a coarse failure code and no stack or cause for an actual BullMQ processor failure', async () => {
    const prefix = `m8-worker-privacy-${randomUUID()}`,
      publisher = new BullMqOutboxPublisher(redis, prefix),
      item = await job(prefix);
    await redis.del(item.key);
    const worker = createDomainEventWorker(redis, prefix, () =>
      Promise.reject(new Error('PRIVATE PROVIDER FAILURE')),
    );
    worker.on('error', () => {});
    try {
      await publisher.publish({ ...item.event, payload: {} });
      await vi.waitFor(
        async () => {
          expect(await redis.hget(item.key, 'failedReason')).toBe('domain_event_processing_failed');
        },
        { timeout: 10000 },
      );
      expect(await redis.hget(item.key, 'stacktrace')).toBe('[]');
      expect(JSON.stringify(await redis.hgetall(item.key))).not.toContain('PRIVATE');
    } finally {
      await worker.close();
      await publisher.close();
    }
  });
});
