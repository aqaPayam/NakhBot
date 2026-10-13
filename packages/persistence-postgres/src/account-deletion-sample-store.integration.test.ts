import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSampleStore } from './account-deletion-sample-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 bounded synthetic source cleanup', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionSampleStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_sample_cleanup');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionSampleStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
      database,
    );
  });
  async function seed(
    userId: string,
    copies = 1,
    leased = false,
  ): Promise<{ sourceId: string; eventId: string; name: string }> {
    const sourceId = randomUUID(),
      eventId = randomUUID(),
      name = 'private synthetic name';
    await database.transaction().execute(async (tx) => {
      await tx
        .insertInto('platform.sample_effects')
        .values({ id: sourceId, actor_user_id: userId, name, created_at: new Date() })
        .execute();
      for (let index = 0; index < copies; index++)
        await tx
          .insertInto('platform.outbox_events')
          .values({
            id: index === 0 ? eventId : randomUUID(),
            aggregate_type: 'sample_effect',
            aggregate_id: sourceId,
            event_type: 'platform.sample-effect-created.v1',
            schema_version: 1,
            payload: { effectId: sourceId, name },
            occurred_at: new Date(),
            available_at: new Date(),
            correlation_id: randomUUID(),
            causation_id: randomUUID(),
            ...(leased
              ? { lease_owner: randomUUID(), lease_expires_at: new Date(Date.now() + 60000) }
              : {}),
          })
          .execute();
      await tx
        .insertInto('platform.sample_projections')
        .values({
          id: randomUUID(),
          effect_id: sourceId,
          source_event_id: eventId,
          projected_name: name,
          projected_at: new Date(),
        })
        .execute();
    });
    return { sourceId, eventId, name };
  }
  async function scene(
    copies = 1,
    leased = false,
  ): Promise<
    Awaited<ReturnType<typeof createDeletionFixture>> &
      Awaited<ReturnType<typeof seed>> & {
        lease: Awaited<ReturnType<PostgresAccountDeletionWorkStore['claimDue']>>[number];
      }
  > {
    let source: Awaited<ReturnType<typeof seed>> | undefined;
    const fixture = await createDeletionFixture(database, async (userId) => {
      source = await seed(userId, copies, leased);
    });
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(
      (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!,
    );
    await checkpoints.finishEvidence(
      (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!,
    );
    return {
      ...fixture,
      ...source!,
      lease: (await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }))[0]!,
    };
  }
  async function facts(
    sourceId: string,
  ): Promise<{ sources: number; projections: number; events: number; receipts: number }> {
    return (
      await sql<{ sources: number; projections: number; events: number; receipts: number }>`SELECT
      (SELECT count(*)::integer FROM platform.sample_effects WHERE id=${sourceId}::uuid) AS sources,
      (SELECT count(*)::integer FROM platform.sample_projections WHERE effect_id=${sourceId}::uuid) AS projections,
      (SELECT count(*)::integer FROM platform.outbox_events WHERE aggregate_type='sample_effect' AND aggregate_id=${sourceId}::uuid) AS events,
      (SELECT count(*)::integer FROM identity.account_deletion_sample_receipts WHERE source_id=${sourceId}::uuid) AS receipts`.execute(
        database,
      )
    ).rows[0]!;
  }
  it('removes one owned source exactly once under twenty retries and preserves counterpart data and original scope', async () => {
    const other = await seed(await createReportUser(database, false));
    const item = await scene();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.purgeNext(item.lease)),
    );
    expect(results.reduce((sum, row) => sum + row.purgedEffects, 0)).toBe(1);
    expect(results.reduce((sum, row) => sum + row.purgedEvents, 0)).toBe(1);
    expect(await facts(item.sourceId)).toEqual({
      sources: 0,
      projections: 0,
      events: 0,
      receipts: 1,
    });
    expect(await facts(other.sourceId)).toEqual({
      sources: 1,
      projections: 1,
      events: 1,
      receipts: 0,
    });
    expect(
      (
        await database
          .selectFrom('platform.sample_reference_anchors')
          .selectAll()
          .where('id', '=', item.sourceId)
          .executeTakeFirstOrThrow()
      ).actor_user_id,
    ).toBe(item.userId);
    const audits = await database
      .selectFrom('platform.audit_logs')
      .select('metadata')
      .where('subject_id', '=', item.recordId)
      .where('event_type', '=', 'account.deletion-product-batch.v1')
      .execute();
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(item.name);
  });
  it('drains 205 event copies in 100/100/5 batches before removing the source and projection', async () => {
    const item = await scene(205);
    expect(await store.purgeNext(item.lease)).toMatchObject({
      purgedEvents: 100,
      purgedEffects: 0,
      hasMore: true,
    });
    expect(await facts(item.sourceId)).toEqual({
      sources: 1,
      projections: 1,
      events: 105,
      receipts: 0,
    });
    expect(await store.purgeNext(item.lease)).toMatchObject({
      purgedEvents: 100,
      purgedEffects: 0,
      hasMore: true,
    });
    expect(await store.purgeNext(item.lease)).toEqual({
      purgedEvents: 5,
      purgedEffects: 1,
      purgedProjections: 1,
      hasMore: false,
      waitingForLease: false,
    });
    expect(await facts(item.sourceId)).toEqual({
      sources: 0,
      projections: 0,
      events: 0,
      receipts: 1,
    });
  });
  it('waits for an active source-event lease and resumes without deleting its body early', async () => {
    const item = await scene(1, true);
    expect(await store.purgeNext(item.lease)).toMatchObject({
      purgedEffects: 0,
      purgedEvents: 0,
      hasMore: true,
      waitingForLease: true,
    });
    expect(await facts(item.sourceId)).toEqual({
      sources: 1,
      projections: 1,
      events: 1,
      receipts: 0,
    });
    await database
      .updateTable('platform.outbox_events')
      .set({ lease_owner: null, lease_expires_at: null })
      .where('id', '=', item.eventId)
      .execute();
    expect(await store.purgeNext(item.lease)).toMatchObject({ purgedEffects: 1, hasMore: false });
  });
  it.each([
    'platform.audit_logs',
    'platform.outbox_events',
    'identity.account_deletion_sample_receipts',
  ] as const)('rolls back complete source removal when %s writing is suppressed', async (table) => {
    const item = await scene();
    await sql`CREATE FUNCTION public.m8_sample_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    await sql
      .raw(
        `CREATE TRIGGER aaa_sample_suppress BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.m8_sample_suppress()`,
      )
      .execute(database);
    try {
      await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
    } finally {
      await sql.raw(`DROP TRIGGER aaa_sample_suppress ON ${table}`).execute(database);
      await sql`DROP FUNCTION public.m8_sample_suppress()`.execute(database);
    }
    expect(await facts(item.sourceId)).toEqual({
      sources: 1,
      projections: 1,
      events: 1,
      receipts: 0,
    });
    expect(await store.purgeNext(item.lease)).toMatchObject({ purgedEffects: 1 });
  });
  it('rejects late source, projection and event creation after the immediate tombstone', async () => {
    const item = await scene();
    await expect(seed(item.userId)).rejects.toMatchObject({ code: '40001' });
    await expect(
      database
        .insertInto('platform.sample_projections')
        .values({
          id: randomUUID(),
          effect_id: item.sourceId,
          source_event_id: randomUUID(),
          projected_name: item.name,
          projected_at: new Date(),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    await store.purgeNext(item.lease);
    await expect(
      database
        .insertInto('platform.outbox_events')
        .values({
          id: randomUUID(),
          aggregate_type: 'sample_effect',
          aggregate_id: item.sourceId,
          event_type: 'platform.sample-effect-created.v1',
          schema_version: 1,
          payload: { effectId: item.sourceId, name: item.name },
          occurred_at: new Date(),
          available_at: new Date(),
          correlation_id: randomUUID(),
          causation_id: randomUUID(),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('denies replay after privileged receipt corruption but tolerates ordinary delivery schedule changes', async () => {
    const item = await scene();
    await store.purgeNext(item.lease);
    const receipt = await database
      .selectFrom('identity.account_deletion_sample_receipts')
      .selectAll()
      .where('source_id', '=', item.sourceId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable('platform.outbox_events')
      .set({ available_at: new Date(Date.now() + 60000) })
      .where('id', '=', receipt.event_id)
      .execute();
    expect(await store.purgeNext(item.lease)).toMatchObject({ purgedEffects: 0, hasMore: false });
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await tx
        .updateTable('identity.account_deletion_sample_receipts')
        .set({ proof_hash: 'f'.repeat(64) })
        .where('source_id', '=', item.sourceId)
        .execute();
    });
    await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
  });
  it.each(['source_owner', 'original_epoch', 'missing_body'] as const)(
    'fails closed on privileged %s drift without claiming deletion',
    async (fault) => {
      const otherUser = await createReportUser(database, false);
      const item = await scene();
      await database.transaction().execute(async (tx) => {
        await sql`SET LOCAL session_replication_role=replica`.execute(tx);
        if (fault === 'source_owner')
          await tx
            .updateTable('platform.sample_effects')
            .set({ actor_user_id: otherUser })
            .where('id', '=', item.sourceId)
            .execute();
        else if (fault === 'original_epoch')
          await tx
            .updateTable('platform.sample_reference_anchors')
            .set({ product_epoch: 1 })
            .where('id', '=', item.sourceId)
            .execute();
        else {
          await tx
            .deleteFrom('platform.sample_projections')
            .where('effect_id', '=', item.sourceId)
            .execute();
          await tx
            .deleteFrom('platform.outbox_events')
            .where('aggregate_type', '=', 'sample_effect')
            .where('aggregate_id', '=', item.sourceId)
            .execute();
          await tx.deleteFrom('platform.sample_effects').where('id', '=', item.sourceId).execute();
        }
      });
      const before = await facts(item.sourceId);
      await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
      expect(await facts(item.sourceId)).toEqual(before);
      expect(before.receipts).toBe(0);
    },
  );
});
