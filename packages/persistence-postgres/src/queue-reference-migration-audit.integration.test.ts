import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { PostgresQueueReferenceMigrationAudit } from './queue-reference-migration-audit.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 immutable queue reference migration audit', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let audit: PostgresQueueReferenceMigrationAudit;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_queue_migration_audit');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    audit = new PostgresQueueReferenceMigrationAudit(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function fixture(): Promise<{
    event: DomainEvent;
    reference: Parameters<typeof audit.prepare>[1];
  }> {
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
    event.payload.name = 'private migration sample';
    await database.transaction().execute(async (tx) => {
      await tx
        .insertInto('platform.sample_effects')
        .values({
          id: event.aggregateId,
          actor_user_id: randomUUID(),
          name: String(event.payload.name),
          created_at: new Date(),
        })
        .execute();
      await tx
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
    });
    return {
      event,
      reference: {
        kind: 'outbox-reference.v1',
        eventId: event.id,
        eventType: event.eventType,
        eventSchemaVersion: 1,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
      },
    };
  }
  it('converges twenty preparations and twenty observations to one immutable chain without source prose', async () => {
    const scene = await fixture();
    const prepared = await Promise.all(
      Array.from({ length: 20 }, () => audit.prepare('a'.repeat(64), scene.reference, scene.event)),
    );
    expect(new Set(prepared).size).toBe(1);
    await Promise.all(Array.from({ length: 20 }, () => audit.observe(prepared[0]!, 'normalized')));
    const records = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('subject_id', '=', scene.event.id)
      .execute();
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain('private migration sample');
    await expect(
      database.deleteFrom('platform.audit_logs').where('id', '=', prepared[0]!).execute(),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('rejects forged legacy bodies before allocating migration authority', async () => {
    const scene = await fixture();
    await expect(
      audit.prepare('a'.repeat(64), scene.reference, {
        ...scene.event,
        payload: { ...scene.event.payload, name: 'private forged source' },
      }),
    ).rejects.toThrow('queue_migration_authority_unavailable');
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', scene.event.id)
        .execute(),
    ).toEqual([]);
  });
  it('fails before authority is returned when its required audit insertion is suppressed', async () => {
    const scene = await fixture();
    await sql`CREATE FUNCTION public.m8_queue_audit_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER aaa_queue_audit_suppress BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION public.m8_queue_audit_suppress()`.execute(
      database,
    );
    try {
      await expect(audit.prepare('a'.repeat(64), scene.reference, scene.event)).rejects.toThrow(
        'queue_migration_authority_unavailable',
      );
    } finally {
      await sql`DROP TRIGGER aaa_queue_audit_suppress ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION public.m8_queue_audit_suppress()`.execute(database);
    }
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', scene.event.id)
        .execute(),
    ).toEqual([]);
    expect(await audit.prepare('a'.repeat(64), scene.reference, scene.event)).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
  });
  it('recovers a lost post-change observation by reconciling the persisted preparation with the exact reference', async () => {
    const scene = await fixture(),
      queueHash = 'a'.repeat(64);
    const id = await audit.prepare(queueHash, scene.reference, scene.event);
    await audit.reconcile(queueHash, { ...scene.reference, aggregateId: randomUUID() });
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('event_type', '=', 'queue.legacy-reference-observed.v1')
        .where('subject_id', '=', scene.event.id)
        .execute(),
    ).toEqual([]);
    await audit.reconcile(queueHash, scene.reference);
    await audit.reconcile(queueHash, scene.reference);
    const observed = await database
      .selectFrom('platform.audit_logs')
      .select('metadata')
      .where('event_type', '=', 'queue.legacy-reference-observed.v1')
      .where('subject_id', '=', scene.event.id)
      .execute();
    expect(observed).toHaveLength(1);
    expect(observed[0]!.metadata.preparedAuditId).toBe(id);
  });
  it('rejects a corrupted preparation rather than blessing an observation', async () => {
    const scene = await fixture(),
      id = await audit.prepare('a'.repeat(64), scene.reference, scene.event);
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await tx
        .updateTable('platform.audit_logs')
        .set({ actor_type: 'user', actor_user_id: randomUUID() })
        .where('id', '=', id)
        .execute();
    });
    await expect(audit.observe(id, 'normalized')).rejects.toThrow(
      'queue_migration_observation_unavailable',
    );
  });
  it('keeps distinct queue namespaces separately bound while preserving canonical event bodies', async () => {
    const scene = await fixture();
    const first = await audit.prepare('a'.repeat(64), scene.reference, scene.event);
    const second = await audit.prepare('b'.repeat(64), scene.reference, scene.event);
    expect(first).not.toBe(second);
    expect(
      (
        await database
          .selectFrom('platform.outbox_events')
          .select('payload')
          .where('id', '=', scene.event.id)
          .executeTakeFirstOrThrow()
      ).payload,
    ).toEqual(scene.event.payload);
  });
});
