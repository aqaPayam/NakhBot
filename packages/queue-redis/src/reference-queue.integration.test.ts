import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@nakh/contracts';
import {
  BullMqOutboxPublisher,
  createDomainEventWorker,
  createRedisConnection,
  DOMAIN_EVENT_QUEUE,
  type QueuedEventHydrator,
  type QueuedEventReference,
} from './index.js';

const url = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined)('M8 reference-only queue protocol', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  function setup(referenceOnly = true): {
    connection: ReturnType<typeof createRedisConnection>;
    prefix: string;
    queue: Queue<DomainEvent | QueuedEventReference>;
    publisher: BullMqOutboxPublisher;
  } {
    const connection = createRedisConnection(url ?? 'redis://invalid'),
      prefix = `m8-reference-${randomUUID()}`;
    const queue = new Queue<DomainEvent | QueuedEventReference>(DOMAIN_EVENT_QUEUE, {
      connection,
      prefix,
    });
    const publisher = new BullMqOutboxPublisher(connection, prefix, referenceOnly);
    cleanup.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
      await publisher.close();
      await connection.quit();
    });
    return { connection, prefix, queue, publisher };
  }
  function event(): DomainEvent {
    const aggregateId = randomUUID();
    return {
      id: randomUUID(),
      eventType: 'platform.sample-effect-created.v1',
      schemaVersion: 1,
      aggregateType: 'sample_effect',
      aggregateId,
      payload: { effectId: aggregateId, name: 'private source prose' },
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    };
  }
  function workerFor(
    scene: ReturnType<typeof setup>,
    hydrate: QueuedEventHydrator,
    processor: (value: DomainEvent) => Promise<void> = () => Promise.resolve(),
  ): {
    completed: Promise<void>;
    failed: Promise<void>;
  } {
    const worker = createDomainEventWorker(scene.connection, scene.prefix, processor, hydrate);
    cleanup.push(() => worker.close());
    return {
      completed: new Promise((resolve) => worker.once('completed', () => resolve())),
      failed: new Promise((resolve) => worker.once('failed', () => resolve())),
    };
  }

  it('stores only bound references under twenty duplicate publication attempts', async () => {
    const scene = setup(),
      source = event();
    await Promise.all(Array.from({ length: 20 }, () => scene.publisher.publish(source)));
    expect(await scene.queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
    const data = (await scene.queue.getJob(source.id))!.data;
    expect(data).toEqual({
      kind: 'outbox-reference.v1',
      eventId: source.id,
      eventType: source.eventType,
      eventSchemaVersion: 1,
      aggregateType: source.aggregateType,
      aggregateId: source.aggregateId,
    });
    expect(JSON.stringify(data)).not.toContain('private source prose');
    expect(Object.keys(data)).not.toContain('payload');
  });

  it('delivers a canonical hydrated body while retaining only the reference in Redis', async () => {
    const scene = setup(),
      source = event();
    let delivered = 0;
    const worker = workerFor(
      scene,
      (reference) => {
        expect(reference.eventId).toBe(source.id);
        return Promise.resolve(source);
      },
      (value) => {
        expect(value).toEqual(source);
        delivered++;
        return Promise.resolve();
      },
    );
    await scene.publisher.publish(source);
    await worker.completed;
    expect(delivered).toBe(1);
    expect(JSON.stringify((await scene.queue.getJob(source.id))!.data)).not.toContain(
      'private source prose',
    );
  });

  it('does not invoke processing when canonical authority proves absence', async () => {
    const scene = setup(),
      source = event();
    let delivered = 0;
    const worker = workerFor(
      scene,
      () => Promise.resolve(undefined),
      () => {
        delivered++;
        return Promise.resolve();
      },
    );
    await scene.publisher.publish(source);
    await worker.completed;
    expect(delivered).toBe(0);
    expect((await scene.queue.getJob(source.id))!.data).toMatchObject({
      kind: 'outbox-reference.v1',
    });
  });

  it('normalizes a valid legacy body before processing so even a later failure keeps no private clone', async () => {
    const scene = setup(false),
      source = event();
    await scene.publisher.publish(source);
    expect(JSON.stringify((await scene.queue.getJob(source.id))!.data)).toContain(
      'private source prose',
    );
    const worker = workerFor(
      scene,
      () => Promise.resolve(source),
      () => Promise.reject(new Error('synthetic_processor_failure')),
    );
    await worker.failed;
    expect((await scene.queue.getJob(source.id))!.data).toMatchObject({
      kind: 'outbox-reference.v1',
    });
    expect(JSON.stringify((await scene.queue.getJob(source.id))!.data)).not.toContain(
      'private source prose',
    );
  });

  it('rejects changed legacy hydration before replacing the original failed work evidence', async () => {
    const scene = setup(false),
      source = event();
    let delivered = 0;
    await scene.publisher.publish(source);
    const worker = workerFor(
      scene,
      () => Promise.resolve({ ...source, payload: { ...source.payload, name: 'forged body' } }),
      () => {
        delivered++;
        return Promise.resolve();
      },
    );
    await worker.failed;
    expect(delivered).toBe(0);
    expect((await scene.queue.getJob(source.id))!.data).toEqual(source);
  });

  it('rejects a mismatched reference/name/job binding before hydration or processing', async () => {
    const scene = setup(),
      source = event();
    let hydrated = 0;
    await scene.publisher.publish(source);
    const job = (await scene.queue.getJob(source.id))!;
    await scene.connection.hset(
      `${scene.prefix}:${DOMAIN_EVENT_QUEUE}:${source.id}`,
      'data',
      JSON.stringify({
        ...job.data,
        eventId: randomUUID(),
        payload: { name: 'private injected body' },
      }),
    );
    const worker = workerFor(scene, () => {
      hydrated++;
      return Promise.resolve(source);
    });
    await worker.failed;
    expect(hydrated).toBe(0);
  });
});
