import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresOutboxStore, PostgresInboxStore, SystemIdGenerator } from './foundation-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSampleStore } from './account-deletion-sample-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 canonical queued event resolution', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let outbox: PostgresOutboxStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_queue_resolution');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 8,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 10000,
    });
    outbox = new PostgresOutboxStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  function reference(event: DomainEvent): {
    eventId: string;
    eventType: string;
    eventSchemaVersion: number;
    aggregateType: string;
    aggregateId: string;
  } {
    return {
      eventId: event.id,
      eventType: event.eventType,
      eventSchemaVersion: event.schemaVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
    };
  }
  async function seed(userId: string = randomUUID()): Promise<DomainEvent> {
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
    event.payload.name = 'private canonical sample';
    await database.transaction().execute(async (tx) => {
      await tx
        .insertInto('platform.sample_effects')
        .values({
          id: event.aggregateId,
          actor_user_id: userId,
          name: String(event.payload.name),
          created_at: new Date(),
        })
        .execute();
      await tx
        .insertInto('platform.outbox_events')
        .values({
          id: event.id,
          event_type: event.eventType,
          schema_version: event.schemaVersion,
          aggregate_type: event.aggregateType,
          aggregate_id: event.aggregateId,
          payload: event.payload,
          occurred_at: new Date(event.occurredAt),
          available_at: new Date(event.occurredAt),
          correlation_id: event.correlationId,
          causation_id: event.causationId,
        })
        .execute();
    });
    return event;
  }

  it('hydrates a live canonical source and projects exactly once under twenty queued reference retries', async () => {
    const event = await seed(),
      inbox = new PostgresInboxStore(database, new SystemIdGenerator());
    const resolved = await Promise.all(
      Array.from({ length: 20 }, () => outbox.resolveQueuedEvent(reference(event))),
    );
    expect(
      resolved.every((candidate) => JSON.stringify(candidate) === JSON.stringify(resolved[0])),
    ).toBe(true);
    expect(resolved[0]).toEqual(event);
    const processed = await Promise.all(
      resolved.map((candidate) => inbox.processSampleEvent(candidate!)),
    );
    expect(processed.filter((result) => result === 'processed')).toHaveLength(1);
    expect(
      await database
        .selectFrom('platform.sample_projections')
        .select('id')
        .where('effect_id', '=', event.aggregateId)
        .execute(),
    ).toHaveLength(1);
  });

  it('accepts a genuine legacy body regardless of JSON object key order', async () => {
    const event = await seed();
    const legacy = { ...event, payload: { name: event.payload.name, effectId: event.aggregateId } };
    expect(await outbox.resolveQueuedEvent(reference(event), legacy)).toEqual(event);
  });

  it.each(['eventType', 'eventSchemaVersion', 'aggregateType', 'aggregateId'] as const)(
    'rejects a changed %s reference before dispatch',
    async (field) => {
      const event = await seed(),
        altered = reference(event);
      if (field === 'eventSchemaVersion') altered[field] = 2;
      else altered[field] = field === 'aggregateId' ? randomUUID() : 'forged';
      await expect(outbox.resolveQueuedEvent(altered)).rejects.toThrow(
        'queued_event_source_conflict',
      );
    },
  );

  it('rejects forged legacy prose, correlation and extra snapshot fields without echoing private data', async () => {
    const event = await seed();
    for (const legacy of [
      { ...event, payload: { ...event.payload, name: 'private forged name' } },
      { ...event, correlationId: randomUUID() },
      { ...event, payload: { ...event.payload, profileSnapshot: 'private forbidden snapshot' } },
    ])
      await expect(outbox.resolveQueuedEvent(reference(event), legacy)).rejects.toThrow(
        'queued_event_source_conflict',
      );
  });

  it('suppresses a live sample body immediately after the real account tombstone', async () => {
    let event!: DomainEvent;
    await createDeletionFixture(database, async (userId) => {
      event = await seed(userId);
    });
    expect(await outbox.resolveQueuedEvent(reference(event))).toBeUndefined();
    expect(await outbox.resolveQueuedEvent(reference(event), event)).toBeUndefined();
    expect(
      await database
        .selectFrom('platform.sample_effects')
        .select('id')
        .where('id', '=', event.aggregateId)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it('resolves a legitimately erased sample as absent using the independent immutable purge proof', async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
      database,
    );
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
    expect(await outbox.resolveQueuedEvent(reference(event))).toBeUndefined();
    expect(await outbox.resolveQueuedEvent(reference(event), event)).toBeUndefined();
    await expect(
      outbox.resolveQueuedEvent(reference(event), {
        ...event,
        payload: { ...event.payload, name: 'forged erased name' },
      }),
    ).rejects.toThrow('queued_event_source_unavailable');
    await expect(
      outbox.resolveQueuedEvent(reference(event), {
        ...event,
        payload: { ...event.payload, snapshot: 'private extra' },
      }),
    ).rejects.toThrow('queued_event_source_conflict');
  });

  it('fails closed when a source disappears without a purge receipt', async () => {
    const event = await seed();
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await tx.deleteFrom('platform.outbox_events').where('id', '=', event.id).execute();
      await tx.deleteFrom('platform.sample_effects').where('id', '=', event.aggregateId).execute();
    });
    await expect(outbox.resolveQueuedEvent(reference(event))).rejects.toThrow(
      'queued_event_source_unavailable',
    );
  });

  it('rejects independently corrupted original name custody', async () => {
    const event = await seed();
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await tx
        .updateTable('platform.sample_reference_anchors')
        .set({ name_digest: 'f'.repeat(64) })
        .where('id', '=', event.aggregateId)
        .execute();
    });
    await expect(outbox.resolveQueuedEvent(reference(event))).rejects.toThrow(
      'queued_event_source_conflict',
    );
  });

  it('keeps financial transport available for a deleted account and refuses missing financial canonical facts', async () => {
    const fixture = await createDeletionFixture(database);
    const event: DomainEvent = {
      id: randomUUID(),
      eventType: 'billing.credit-increased.v1',
      schemaVersion: 1,
      aggregateType: 'credit_account',
      aggregateId: fixture.userId,
      payload: { creditTransactionId: randomUUID(), amount: '10', balanceAfter: '10' },
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    };
    await database
      .insertInto('platform.outbox_events')
      .values({
        id: event.id,
        event_type: event.eventType,
        schema_version: 1,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        payload: event.payload,
        occurred_at: new Date(event.occurredAt),
        available_at: new Date(event.occurredAt),
        correlation_id: event.correlationId,
        causation_id: event.causationId,
      })
      .execute();
    expect(await outbox.resolveQueuedEvent(reference(event), event)).toEqual(event);
    await expect(
      outbox.resolveQueuedEvent({ ...reference(event), eventId: randomUUID() }),
    ).rejects.toThrow('queued_event_source_unavailable');
  });
});
