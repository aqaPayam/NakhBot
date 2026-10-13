import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@nakh/contracts';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  PostgresOutboxStore,
  PostgresInboxStore,
  SystemIdGenerator,
  PostgresAccountDeletionWorkStore,
  PostgresAccountDeletionCheckpointStore,
  PostgresAccountDeletionSampleStore,
  PostgresQueueReferenceMigrationAudit,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  BullMqOutboxPublisher,
  BullMqLegacyReferenceMigration,
  createDomainEventWorker,
  createRedisConnection,
  DOMAIN_EVENT_QUEUE,
} from '@nakh/queue-redis';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createDeletionFixture } from '../../../packages/persistence-postgres/src/testing/deletion-fixture.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(databaseUrl === undefined || redisUrl === undefined)(
  'M8 real PostgreSQL/Redis reference delivery',
  () => {
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    const connection = createRedisConnection(redisUrl ?? 'redis://invalid');
    const cleanup: Array<() => Promise<void>> = [];
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(databaseUrl!, 'm8_reference_delivery');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 8,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 10000,
      });
    });
    afterAll(async () => {
      for (const close of cleanup.reverse()) await close();
      await connection.quit();
      await database?.destroy();
      await isolated?.destroy();
    });
    async function seed(userId: string = randomUUID()): Promise<DomainEvent> {
      const sourceId = randomUUID(),
        at = new Date();
      const event: DomainEvent = {
        id: randomUUID(),
        eventType: 'platform.sample-effect-created.v1',
        schemaVersion: 1,
        aggregateType: 'sample_effect',
        aggregateId: sourceId,
        payload: { effectId: sourceId, name: 'private end-to-end sample' },
        occurredAt: at.toISOString(),
        correlationId: randomUUID(),
        causationId: randomUUID(),
      };
      await database.transaction().execute(async (tx) => {
        await tx
          .insertInto('platform.sample_effects')
          .values({
            id: sourceId,
            actor_user_id: userId,
            name: String(event.payload.name),
            created_at: at,
          })
          .execute();
        await tx
          .insertInto('platform.outbox_events')
          .values({
            id: event.id,
            event_type: event.eventType,
            schema_version: 1,
            aggregate_type: event.aggregateType,
            aggregate_id: sourceId,
            payload: event.payload,
            occurred_at: at,
            available_at: at,
            correlation_id: event.correlationId,
            causation_id: event.causationId,
          })
          .execute();
      });
      return event;
    }
    async function deliver(event: DomainEvent): Promise<number> {
      const prefix = `m8-delivery-${randomUUID()}`,
        publisher = new BullMqOutboxPublisher(connection, prefix, true);
      const outbox = new PostgresOutboxStore(database),
        inbox = new PostgresInboxStore(database, new SystemIdGenerator());
      let processed = 0;
      const worker = createDomainEventWorker(
        connection,
        prefix,
        async (current) => {
          await inbox.processSampleEvent(current);
          processed++;
        },
        (reference, legacy) => outbox.resolveQueuedEvent(reference, legacy),
      );
      cleanup.push(async () => {
        await worker.close();
        await publisher.close();
      });
      const completed = new Promise<void>((resolveCompleted, reject) => {
        worker.once('completed', () => resolveCompleted());
        worker.once('failed', () => reject(new Error('reference_delivery_failed')));
      });
      await Promise.all(Array.from({ length: 20 }, () => publisher.publish(event)));
      await completed;
      const body = await connection.hget(`${prefix}:${DOMAIN_EVENT_QUEUE}:${event.id}`, 'data');
      expect(body).not.toContain('private end-to-end sample');
      const queued: unknown = JSON.parse(body!);
      expect(queued).toMatchObject({ kind: 'outbox-reference.v1' });
      return processed;
    }

    it('hydrates real canonical facts and deduplicates reference delivery without a queued private body', async () => {
      const event = await seed();
      expect(await deliver(event)).toBe(1);
      const projection = await database
        .selectFrom('platform.sample_projections')
        .select('projected_name')
        .where('effect_id', '=', event.aggregateId)
        .executeTakeFirstOrThrow();
      expect(projection.projected_name).toBe(event.payload.name);
    });

    it('makes a late reference harmless after actual audited source purge and never restores a projection', async () => {
      let event!: DomainEvent;
      await createDeletionFixture(database, async (userId) => {
        event = await seed(userId);
      });
      const work = new PostgresAccountDeletionWorkStore(database),
        checkpoints = new PostgresAccountDeletionCheckpointStore(database);
      const claim = async (): Promise<Awaited<ReturnType<typeof work.claimDue>>[number]> =>
        (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!;
      await checkpoints.finishShared(await claim());
      await checkpoints.finishEvidence(await claim());
      await new PostgresAccountDeletionSampleStore(database).purgeNext(await claim());
      expect(await deliver(event)).toBe(0);
      expect(
        await database
          .selectFrom('platform.sample_projections')
          .select('id')
          .where('effect_id', '=', event.aggregateId)
          .execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom('platform.sample_effects')
          .select('id')
          .where('id', '=', event.aggregateId)
          .execute(),
      ).toEqual([]);
    });
    it('normalizes an inactive real legacy job behind native append-only authority while preserving its canonical body', async () => {
      const event = await seed(),
        prefix = `m8-legacy-real-${randomUUID()}`;
      const publisher = new BullMqOutboxPublisher(connection, prefix);
      cleanup.push(() => publisher.close());
      await publisher.publish(event);
      const key = `${prefix}:${DOMAIN_EVENT_QUEUE}:${event.id}`;
      expect(await connection.hget(key, 'data')).toContain('private end-to-end sample');
      const migrator = new BullMqLegacyReferenceMigration(
        connection,
        prefix,
        new PostgresQueueReferenceMigrationAudit(database),
      );
      const result = await migrator.scanNext({ redisCursor: '0', pendingKeys: [key] });
      expect(result.normalized).toBe(1);
      expect(await connection.hget(key, 'data')).not.toContain('private end-to-end sample');
      const records = await database
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('subject_id', '=', event.id)
        .execute();
      expect(records).toHaveLength(2);
      expect(JSON.stringify(records)).not.toContain('private end-to-end sample');
      expect(
        (
          await database
            .selectFrom('platform.outbox_events')
            .select('payload')
            .where('id', '=', event.id)
            .executeTakeFirstOrThrow()
        ).payload,
      ).toEqual(event.payload);
    });
    it('reconciles a real persisted preparation after normalization succeeds but post-change observation fails', async () => {
      const event = await seed(),
        prefix = `m8-legacy-recovery-${randomUUID()}`;
      const publisher = new BullMqOutboxPublisher(connection, prefix);
      cleanup.push(() => publisher.close());
      await publisher.publish(event);
      const key = `${prefix}:${DOMAIN_EVENT_QUEUE}:${event.id}`,
        native = new PostgresQueueReferenceMigrationAudit(database);
      const migrator = new BullMqLegacyReferenceMigration(connection, prefix, {
        prepare: (hash, reference, legacy) => native.prepare(hash, reference, legacy),
        observe: () => Promise.reject(new Error('synthetic_observation_failure')),
        reconcile: (hash, reference) => native.reconcile(hash, reference),
      });
      await expect(migrator.scanNext({ redisCursor: '0', pendingKeys: [key] })).rejects.toThrow(
        'synthetic_observation_failure',
      );
      expect(await connection.hget(key, 'data')).not.toContain('private end-to-end sample');
      await migrator.scanNext({ redisCursor: '0', pendingKeys: [key] });
      const records = await database
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('subject_id', '=', event.id)
        .execute();
      expect(records).toHaveLength(2);
      expect(records.some((record) => record.metadata.outcome === 'already_reference')).toBe(true);
    });
  },
);
